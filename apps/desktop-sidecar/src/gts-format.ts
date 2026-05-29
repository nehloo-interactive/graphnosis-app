/**
 * GTS format — Graphnosis Trained Skill pack serialization.
 *
 * A `.gts` file is AES-256-GCM encrypted JSON (not a zip). The encryption is
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

// ── GTS format types ──────────────────────────────────────────────────────────

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

export interface GtsSkill {
  name: string;
  engramTemplate: 'skill';
  sensitivityTier: 'personal' | 'sensitive';
  baseText: string;
  recallRecipes: RecallRecipe[];
  /** Present when this pack was re-exported as a delta on top of an official pack. */
  basedOn?: string;
  /** Semantic modification instructions (diff-only community pack). */
  trainingDelta?: Array<{ section: string; instruction: string }>;
  /** Readable fallback for users without the base pack or local LLM. */
  trainedTextFallback?: string;
}

export interface GtsPayload {
  formatVersion: '1';
  kind: 'official' | 'community';
  id: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  tierRequired: 'free' | 'pro';
  skills: GtsSkill[];
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
const GTS_ENC_KEY = Buffer.from([
  0x47, 0x72, 0x61, 0x70, 0x68, 0x6e, 0x6f, 0x73,
  0x69, 0x73, 0x47, 0x54, 0x53, 0x4b, 0x65, 0x79,
  0x32, 0x30, 0x32, 0x36, 0x50, 0x72, 0x6f, 0x50,
  0x61, 0x63, 0x6b, 0x46, 0x6f, 0x72, 0x6d, 0x61,
]);

// Ed25519 signing public key for official packs — same key as license tokens.
// PLACEHOLDER: replace with real production key before launch.
const GTS_SIGNING_PUBLIC_KEY = new Uint8Array([
  0x3d, 0x4a, 0x7f, 0x1e, 0x92, 0xb8, 0x45, 0xc3,
  0xf6, 0x2d, 0x8e, 0x51, 0x9a, 0x73, 0x0c, 0xb9,
  0x67, 0xad, 0x14, 0xf8, 0x3b, 0x2c, 0x59, 0xe7,
  0x81, 0xd0, 0x46, 0xaa, 0x5f, 0xce, 0x93, 0x28,
]);

// ── Wire format: [4-byte magic][12-byte IV][16-byte auth tag][N-byte ciphertext]
const MAGIC = Buffer.from('GTS1');

// ── buildGtsPackage ───────────────────────────────────────────────────────────

/**
 * Serialize and encrypt a GtsPayload into `.gts` bytes.
 *
 * `signingKeyHex` is the 64-byte Ed25519 secret key (hex) for signing official
 * packs. Omit (or pass undefined) for community packs — `signature` stays "".
 *
 * Privacy: this function serializes only the structural payload (skill texts,
 * recipes, graphnosisMd). It never sees personal memory engrams — the caller
 * is responsible for scoping the payload to Skills-engram data only.
 */
export function buildGtsPackage(payload: GtsPayload, signingKeyHex?: string): Buffer {
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

  const finalPayload: GtsPayload = { ...payload, signature };
  const json = JSON.stringify(finalPayload);

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', GTS_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

// ── parseGtsPackage ───────────────────────────────────────────────────────────

/**
 * Decrypt and parse a `.gts` Buffer. Returns the GtsPayload on success.
 * Throws on malformed data, bad magic, or decryption failure.
 * Does NOT verify the Ed25519 signature — call `verifyGtsSignature` separately.
 */
export function parseGtsPackage(data: Buffer): GtsPayload {
  if (data.length < MAGIC.length + 12 + 16 + 2) {
    throw new Error('GTS data is too short to be a valid pack.');
  }

  const magic = data.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('Not a valid GTS pack (bad magic bytes). Expected GTS1 header.');
  }

  const iv      = data.subarray(4, 16);
  const authTag = data.subarray(16, 32);
  const ciphertext = data.subarray(32);

  const decipher = createDecipheriv('aes-256-gcm', GTS_ENC_KEY, iv);
  decipher.setAuthTag(authTag);

  let json: string;
  try {
    json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('GTS decryption failed. The file may be corrupted or from an incompatible version.');
  }

  try {
    return JSON.parse(json) as GtsPayload;
  } catch {
    throw new Error('GTS payload is not valid JSON.');
  }
}

// ── verifyGtsSignature ────────────────────────────────────────────────────────

/**
 * Verify the Ed25519 signature on an official GTS pack.
 * Returns true for valid official packs, false for community packs (empty sig),
 * and throws if the signature is present but invalid.
 *
 * Call AFTER parseGtsPackage.
 */
export async function verifyGtsSignature(payload: GtsPayload): Promise<boolean> {
  if (!payload.signature) return false; // community pack — no signature

  await sodium.ready;

  const payloadForVerification = JSON.stringify({ ...payload, signature: '' });
  const payloadBytes = new TextEncoder().encode(payloadForVerification);

  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(payload.signature, 'base64'));
  } catch {
    throw new Error('GTS signature is not valid base64.');
  }

  if (sigBytes.length !== sodium.crypto_sign_BYTES) {
    throw new Error(`GTS signature has wrong length (got ${sigBytes.length}, expected ${sodium.crypto_sign_BYTES}).`);
  }

  const valid = sodium.crypto_sign_verify_detached(sigBytes, payloadBytes, GTS_SIGNING_PUBLIC_KEY);
  if (!valid) throw new Error('GTS signature verification failed — pack may have been tampered with.');

  return true;
}

// ── generateGraphnosisMd ──────────────────────────────────────────────────────

/**
 * Generate the GRAPHNOSIS.md drop-in file content from a GtsPayload.
 * This is the flagship file users drop into their project root — one file
 * with all recall recipes embedded as named blocks.
 */
export function generateGraphnosisMd(payload: GtsPayload): string {
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
