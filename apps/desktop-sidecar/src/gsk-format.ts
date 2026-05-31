/**
 * GSK format — Graphnosis Skills Kit pack serialization.
 *
 * A `.gsk` file is AES-256-GCM encrypted JSON (not a zip). The encryption is
 * obfuscation-grade: the key is hardcoded in the app bundle so users can't
 * accidentally double-click a raw JSON file. The real integrity guarantee is
 * the Ed25519 signature in the payload's `signature` field.
 *
 * Official packs: signed with the Graphnosis master key (never in this repo).
 * Community packs: `signature = ""` — import UI shows "unverified" badge.
 *
 * The Ed25519 public key for official pack verification is the same key used
 * for license tokens (`SIGNING_PUBLIC_KEY` in `license-validator.ts`).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';

// ── GSK format types ──────────────────────────────────────────────────────────

export interface SkillGoals {
  /** What a successful outcome looks like for this skill. */
  successLooksLike: string;
  /** What is explicitly out of scope — the skill should not attempt this. */
  outOfScope: string;
  /** What tangible output or behaviour is expected when the skill completes. */
  expectedOnCompletion: string;
  /** When the AI should autonomously invoke this skill (Trigger:). */
  trigger?: string;
  /** What must be true before step 1 can run (Prerequisites:). */
  prerequisites?: string;
  /** Recovery / fallback behaviour if execution fails mid-procedure (On failure:).
   *  May contain a `@skill: name` reference to a recovery skill — `linkSkillCalls`
   *  detects this and writes an `evidence='skill:calls;onFailure=true'` edge. */
  onFailure?: string;
  /** Named inputs this skill expects from its caller or context (Requires:).
   *  Convention: comma-separated `$camelCase` variable names. */
  requires?: string;
  /** Named outputs this skill makes available to callers (Produces:).
   *  Convention: comma-separated `$camelCase` variable names. */
  produces?: string;
}

export interface RecallRecipeStep {
  tool: string;
  query: string;
  onlyEngrams?: string[];
  ifResultsBelow?: number;
}

export interface RecallRecipe {
  name: string;
  trigger: string;
  steps: RecallRecipeStep[];
}

export interface GskSkill {
  name: string;
  engramTemplate: 'skill';
  sensitivityTier: 'personal' | 'sensitive';
  baseText: string;
  recallRecipes: RecallRecipe[];
  /** Optional structured goals for this skill. */
  goals?: SkillGoals;
  /** Present when this pack was re-exported as a delta on top of an official pack. */
  basedOn?: string;
  /** Semantic modification instructions (diff-only community pack). */
  trainingDelta?: Array<{ section: string; instruction: string }>;
  /** Readable fallback for users without the base pack or local LLM. */
  trainedTextFallback?: string;
}

export interface GskPayload {
  formatVersion: '1';
  kind: 'official' | 'community';
  id: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  tierRequired: 'free' | 'pro';
  skills: GskSkill[];
  /**
   * Full GRAPHNOSIS.md content to write into the user's project root.
   * Contains recall recipes embedded as named blocks.
   */
  graphnosisMd: string;
  /**
   * Ed25519 signature over the payload JSON with this field set to "".
   * Official packs: base64-encoded 64-byte signature.
   * Community packs: "" (no signature — import UI shows "unverified" badge).
   */
  signature: string;
}

// ── Encryption constants ──────────────────────────────────────────────────────

// 32-byte AES-256-GCM key. Hardcoded for obfuscation, not security —
// the real integrity check is the Ed25519 signature in the payload.
// ASCII: "GraphnosisGSKKey2026ProPackForma"
const GSK_ENC_KEY = Buffer.from([
  0x47, 0x72, 0x61, 0x70, 0x68, 0x6e, 0x6f, 0x73,
  0x69, 0x73, 0x47, 0x53, 0x4b, 0x4b, 0x65, 0x79,
  0x32, 0x30, 0x32, 0x36, 0x50, 0x72, 0x6f, 0x50,
  0x61, 0x63, 0x6b, 0x46, 0x6f, 0x72, 0x6d, 0x61,
]);

// Ed25519 signing public key for official packs.
// Rotated via scripts/gen-gsk-keypair.mjs (the matching secret lives only at
// ~/.graphnosis/gsk-signing.secret + the maintainer's password manager).
const GSK_SIGNING_PUBLIC_KEY = new Uint8Array([
  0xb1, 0xc2, 0x08, 0xba, 0xd5, 0x81, 0x67, 0xef,
  0x2e, 0x2a, 0xa1, 0x8a, 0x61, 0x50, 0xbc, 0x5f,
  0xc9, 0x98, 0x7f, 0xdd, 0x0e, 0xf0, 0x6f, 0xe3,
  0x5a, 0x93, 0xbf, 0xc1, 0xbd, 0xa4, 0x1e, 0x71,
]);

// ── Wire format: [4-byte magic][12-byte IV][16-byte auth tag][N-byte ciphertext]
const MAGIC = Buffer.from('GSK1');

// ── buildGskPackage ───────────────────────────────────────────────────────────

/**
 * Serialize and encrypt a GskPayload into `.gsk` bytes.
 *
 * `signingKeyHex` is the 64-byte Ed25519 secret key (hex) for signing official
 * packs. Omit (or pass undefined) for community packs — `signature` stays "".
 *
 * Privacy: this function serializes only the structural payload (skill texts,
 * recipes, graphnosisMd). It never sees personal memory engrams — the caller
 * is responsible for scoping the payload to Skills-engram data only.
 */
export function buildGskPackage(payload: GskPayload, signingKeyHex?: string): Buffer {
  // Sign if a secret key was provided
  let signature = '';
  if (signingKeyHex) {
    const payloadForSigning = JSON.stringify({ ...payload, signature: '' });
    const payloadBytes = new TextEncoder().encode(payloadForSigning);
    const secretKey = Buffer.from(signingKeyHex, 'hex');
    if (secretKey.length === 64) {
      // libsodium must be ready — callers should ensure this is called
      // only after LicenseValidator.create() has awaited sodium.ready.
      const sigBytes = sodium.crypto_sign_detached(payloadBytes, secretKey);
      signature = Buffer.from(sigBytes).toString('base64');
    }
  }

  const finalPayload: GskPayload = { ...payload, signature };
  const json = JSON.stringify(finalPayload);

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', GSK_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

// ── parseGskPackage ───────────────────────────────────────────────────────────

/**
 * Decrypt and parse a `.gsk` Buffer. Returns the GskPayload on success.
 * Throws on malformed data, bad magic, or decryption failure.
 * Does NOT verify the Ed25519 signature — call `verifyGskSignature` separately.
 */
export function parseGskPackage(data: Buffer): GskPayload {
  if (data.length < MAGIC.length + 12 + 16 + 2) {
    throw new Error('GSK data is too short to be a valid pack.');
  }

  const magic = data.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('Not a valid GSK pack (bad magic bytes). Expected GSK1 header.');
  }

  const iv      = data.subarray(4, 16);
  const authTag = data.subarray(16, 32);
  const ciphertext = data.subarray(32);

  const decipher = createDecipheriv('aes-256-gcm', GSK_ENC_KEY, iv);
  decipher.setAuthTag(authTag);

  let json: string;
  try {
    json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('GSK decryption failed. The file may be corrupted or from an incompatible version.');
  }

  try {
    return JSON.parse(json) as GskPayload;
  } catch {
    throw new Error('GSK payload is not valid JSON.');
  }
}

// ── verifyGskSignature ────────────────────────────────────────────────────────

/**
 * Verify the Ed25519 signature on an official GSK pack.
 * Returns true for valid official packs, false for community packs (empty sig),
 * and throws if the signature is present but invalid.
 *
 * Call AFTER parseGskPackage.
 */
export async function verifyGskSignature(payload: GskPayload): Promise<boolean> {
  if (!payload.signature) return false; // community pack — no signature

  await sodium.ready;

  const payloadForVerification = JSON.stringify({ ...payload, signature: '' });
  const payloadBytes = new TextEncoder().encode(payloadForVerification);

  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(payload.signature, 'base64'));
  } catch {
    throw new Error('GSK signature is not valid base64.');
  }

  if (sigBytes.length !== sodium.crypto_sign_BYTES) {
    throw new Error(`GSK signature has wrong length (got ${sigBytes.length}, expected ${sodium.crypto_sign_BYTES}).`);
  }

  const valid = sodium.crypto_sign_verify_detached(sigBytes, payloadBytes, GSK_SIGNING_PUBLIC_KEY);
  if (!valid) throw new Error('GSK signature verification failed — pack may have been tampered with.');

  return true;
}

// ── generateGraphnosisMd ──────────────────────────────────────────────────────

/**
 * Generate the GRAPHNOSIS.md drop-in file content from a GskPayload.
 * This is the flagship file users drop into their project root — one file
 * with all recall recipes embedded as named blocks.
 */
export function generateGraphnosisMd(payload: GskPayload): string {
  const lines: string[] = [
    `# Graphnosis Memory — ${payload.displayName}`,
    '',
    `This project uses **Graphnosis** (${payload.kind === 'official' ? 'Official' : 'Community'} Skills Pack) for persistent AI memory.`,
    '',
    '## Skills in this pack',
    '',
  ];

  for (const skill of payload.skills) {
    lines.push(`- **${skill.name}**`);
  }

  lines.push('');
  lines.push('## Recall Recipes');
  lines.push('');
  lines.push('Run these before acting on tasks covered by the skills above:');
  lines.push('');

  for (const skill of payload.skills) {
    for (const recipe of skill.recallRecipes) {
      lines.push(`### \`${recipe.name}\``);
      lines.push('');
      lines.push(`**Trigger:** ${recipe.trigger}`);
      lines.push('');
      lines.push('**Steps:**');
      lines.push('```');
      for (const step of recipe.steps) {
        const engrams = step.onlyEngrams?.length ? ` only_engrams: [${step.onlyEngrams.map(e => `"${e}"`).join(', ')}]` : '';
        const threshold = step.ifResultsBelow !== undefined ? ` (if < ${step.ifResultsBelow} results)` : '';
        lines.push(`${step.tool} "${step.query}"${engrams}${threshold}`);
      }
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Pack: ${payload.displayName} v${payload.version} by ${payload.author}*`);

  return lines.join('\n');
}
