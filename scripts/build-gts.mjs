#!/usr/bin/env node
/**
 * build-gts.mjs — compile default skill packs into .gts binaries.
 *
 * Usage:
 *   node scripts/build-gts.mjs [--sign] [--out <dir>]
 *
 *   --sign        Sign with the Ed25519 master key. Requires the environment
 *                 variable GTS_SIGNING_KEY_HEX (64-byte hex secret key).
 *                 Unsigned packs get kind='community' in the import UI.
 *   --out <dir>   Output directory (default: dist/packs). GITIGNORED.
 *
 * Prerequisites (none committed — all gitignored):
 *   apps/desktop-sidecar/src/default-skill-packs.ts   ← content file you author
 *
 * The script imports default-skill-packs.ts via tsx, runs every content
 * assertion below, and only calls buildGtsPackage() if all assertions pass.
 * On any failure it prints the specific assertion and exits non-zero without
 * writing any .gts file.
 *
 * CONTENT POLICY
 * ─────────────
 * All skill text and recall recipe wording must be wholly original.
 * The assertions below enforce this mechanically. They are not exhaustive —
 * a clean run does not constitute legal clearance. Review the output of
 * --dry-run manually before signing an official pack.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    sign:    { type: 'boolean', default: false },
    out:     { type: 'string',  default: 'dist/packs' },
    'dry-run': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
  strict: true,
});

const OUT_DIR    = resolve(flags.out);
const DRY_RUN    = flags['dry-run'];
const SIGN       = flags.sign;
const VERBOSE    = flags.verbose;

// ── Assertion helpers ─────────────────────────────────────────────────────────

let assertionsFailed = 0;

function fail(packId, field, message) {
  console.error(`\n  ✗ [${packId}] ${field}\n    ${message}`);
  assertionsFailed++;
}

function pass(packId, field) {
  if (VERBOSE) console.log(`  ✓ [${packId}] ${field}`);
}

// ── Content verification assertions ──────────────────────────────────────────
//
// IMPORTANT: these checks are heuristic, not legal opinion.
// A pack that passes all assertions still requires human review before signing.

/**
 * Trademarked methodology names that must not appear in skill text or recipe
 * queries as prescriptive instructions. Descriptive references ("similar to
 * Scrum's sprint cadence") are flagged too — reword as general process language.
 *
 * Add to this list whenever a new methodology name is encountered during review.
 */
const TRADEMARKED_METHODOLOGIES = [
  // Project / agile
  'Scrum', 'PRINCE2', 'SAFe', 'LeSS', 'DAD', 'Nexus',
  // Quality / ops
  'Six Sigma', 'DMAIC', 'DMADV', 'Lean Six Sigma', 'ITIL', 'COBIT',
  // Architecture / enterprise
  'TOGAF', 'Zachman', 'FEAF',
  // Project management bodies
  'PMBOK', 'BABOK', 'DMBoK',
  // Sales / consulting
  'SPIN Selling', 'Challenger Sale', 'Miller Heiman', 'Sandler',
  // Personal productivity (trademarked systems)
  'Getting Things Done', 'GTD', 'Pomodoro Technique', 'Bullet Journal',
  // Design
  'Design Thinking', // descriptive OK; prescriptive ("use Design Thinking to…") not
  'IDEO',
  // Specific named AI products used prescriptively
  // (referencing Graphnosis tools is always OK)
  'ChatGPT', 'Copilot', 'Gemini', 'Grok',
];

/**
 * Regulatory body / standards text that must not be quoted verbatim.
 * Describing the concept is fine; reproducing the standard text is not.
 */
const REGULATORY_VERBATIM_FRAGMENTS = [
  // ISO / IEC
  'ISO 9001', 'ISO 27001', 'ISO 13485',
  // FDA
  '21 CFR Part 11', '21 CFR 820',
  // HIPAA / HITECH (CFR references, not the concept)
  '45 CFR 164', '45 CFR 160',
  // NIST
  'NIST SP 800',
  // NERC CIP
  'NERC CIP-002', 'NERC CIP-003',
];

/**
 * MCP tool names that exist in Graphnosis as of v1.12.
 * Recipe steps referencing unknown tool names are rejected.
 */
const VALID_MCP_TOOLS = new Set([
  'recall', 'remind', 'dig_deeper', 'remember', 'forget', 'apply', 'stats', 'vitality',
  'list_engrams', 'suggest_engram', 'browse_engram', 'recent', 'get_engram_schema',
  'recall_structured', 'recall_with_citations', 'compare_engrams', 'cross_search',
  'find_source', 'recall_source', 'transfer_source',
  'ingest_batch', 'engram_summary',
  'duplicate_pairs', 'healing_journal', 'gnn_status', 'confirm_data_access',
  'audit_memory', 'check_duplicate',
  'edit',
  'develop', 'predict', 'insights', 'gnn_neighbors', 'llm_query', 'llm_distill',
  'train_skill', 'skill_vitality', 'export_skill',
]);

/** Maximum age of contentVerifiedAt before the build refuses to proceed. */
const MAX_VERIFICATION_AGE_DAYS = 90;

// ── Per-pack verification ─────────────────────────────────────────────────────

function verifyPack(pack) {
  const id = pack.id ?? '(no id)';
  console.log(`\nVerifying: ${id} — "${pack.displayName}"`);

  // ── Structural assertions ─────────────────────────────────────────────────

  if (!pack.id || !/^[a-z0-9-]+$/.test(pack.id)) {
    fail(id, 'id', 'Must be lowercase kebab-case (a-z, 0-9, hyphens only).');
  } else { pass(id, 'id'); }

  if (!pack.version || !/^\d+\.\d+\.\d+$/.test(pack.version)) {
    fail(id, 'version', `Must be semantic version (x.y.z). Got: "${pack.version}"`);
  } else { pass(id, 'version'); }

  if (!Array.isArray(pack.skills) || pack.skills.length === 0) {
    fail(id, 'skills', 'Must contain at least one skill.');
  }

  // ── Authoring-time metadata ───────────────────────────────────────────────

  if (!pack.contentVerifiedAt) {
    fail(id, 'contentVerifiedAt',
      'Missing. Run a content review, set contentVerifiedAt to today\'s ISO date.');
  } else {
    const age = (Date.now() - new Date(pack.contentVerifiedAt).getTime()) / 86_400_000;
    if (age > MAX_VERIFICATION_AGE_DAYS) {
      fail(id, 'contentVerifiedAt',
        `Last verification was ${Math.floor(age)} days ago (max ${MAX_VERIFICATION_AGE_DAYS}). Re-verify and update the date.`);
    } else { pass(id, 'contentVerifiedAt'); }
  }

  if (!pack.verifiedBy) {
    fail(id, 'verifiedBy', 'Must identify who performed the content review.');
  } else { pass(id, 'verifiedBy'); }

  if (Array.isArray(pack.contentWarnings) && pack.contentWarnings.length > 0) {
    for (const w of pack.contentWarnings) {
      fail(id, 'contentWarnings', `Unresolved warning: "${w}"`);
    }
  } else { pass(id, 'contentWarnings'); }

  // ── Per-skill content assertions ──────────────────────────────────────────

  for (const skill of (pack.skills ?? [])) {
    const sId = `${id} › ${skill.name ?? '(unnamed)'}`;

    if (skill.engramTemplate !== 'skill') {
      fail(sId, 'engramTemplate', `Must be "skill". Got: "${skill.engramTemplate}"`);
    }

    if (!skill.trainedTextFallback || skill.trainedTextFallback.trim().length < 50) {
      fail(sId, 'trainedTextFallback',
        'Must be a complete, readable description (≥50 chars). ' +
        'This is shown to users without a local LLM — write it first.');
    } else { pass(sId, 'trainedTextFallback'); }

    // Scan baseText and trainedTextFallback for trademarked methodology names
    const textCorpus = [
      skill.baseText ?? '',
      skill.trainedTextFallback ?? '',
      ...(skill.recallRecipes ?? []).flatMap(r => [
        r.trigger ?? '',
        ...(r.steps ?? []).map(s => s.query ?? ''),
      ]),
    ].join('\n');

    for (const term of TRADEMARKED_METHODOLOGIES) {
      // Case-insensitive whole-word match
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(textCorpus)) {
        fail(sId, 'trademark',
          `Contains trademarked methodology name: "${term}". ` +
          'Reword using general professional vocabulary.');
      }
    }

    for (const fragment of REGULATORY_VERBATIM_FRAGMENTS) {
      if (textCorpus.includes(fragment)) {
        fail(sId, 'regulatory-verbatim',
          `Contains regulatory standard citation: "${fragment}". ` +
          'Describe the concept in original language instead of quoting the standard.');
      }
    }

    // Validate MCP tool names in recipe steps
    for (const recipe of (skill.recallRecipes ?? [])) {
      for (const step of (recipe.steps ?? [])) {
        if (!VALID_MCP_TOOLS.has(step.tool)) {
          fail(sId, `recipe:${recipe.name}`,
            `Unknown MCP tool: "${step.tool}". ` +
            `Valid tools: ${[...VALID_MCP_TOOLS].join(', ')}`);
        } else { pass(sId, `tool:${step.tool}`); }
      }
    }

    pass(sId, 'content scan complete');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('build-gts.mjs — Graphnosis skill pack compiler\n');

  // Dynamic import so the content file can be a .ts file run via tsx/ts-node
  const contentPath = resolve(
    'apps/desktop-sidecar/src/default-skill-packs.ts'
  );
  console.log(`Loading content from: ${contentPath}`);

  let packs;
  try {
    const mod = await import(contentPath);
    packs = mod.packs ?? mod.default;
  } catch (err) {
    console.error(
      '\n✗ Could not load default-skill-packs.ts.\n' +
      '  Make sure the file exists (it is gitignored — create it locally).\n' +
      `  Error: ${err.message}`
    );
    process.exit(1);
  }

  if (!Array.isArray(packs) || packs.length === 0) {
    console.error('\n✗ default-skill-packs.ts must export `packs` as a non-empty array.');
    process.exit(1);
  }

  // ── Run verification on every pack ─────────────────────────────────────────
  console.log(`\n══ Content verification (${packs.length} pack(s)) ══`);
  for (const pack of packs) verifyPack(pack);

  if (assertionsFailed > 0) {
    console.error(
      `\n✗ ${assertionsFailed} assertion(s) failed. ` +
      'Fix all issues before compiling. No .gts files were written.'
    );
    process.exit(1);
  }

  console.log('\n✓ All content assertions passed.\n');

  if (DRY_RUN) {
    console.log('--dry-run: skipping compilation. No .gts files written.');
    process.exit(0);
  }

  // ── Compile ────────────────────────────────────────────────────────────────
  const { buildGtsPackage } = await import(
    resolve('apps/desktop-sidecar/src/gts-format.js')
  );

  const signingKey = SIGN ? process.env.GTS_SIGNING_KEY_HEX : undefined;
  if (SIGN && !signingKey) {
    console.error(
      '✗ --sign requires the environment variable GTS_SIGNING_KEY_HEX.\n' +
      '  Export the 64-byte Ed25519 secret key as hex before running with --sign.'
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Output directory: ${OUT_DIR}\n`);

  for (const pack of packs) {
    // Strip authoring-time fields before serialization
    const { contentVerifiedAt, verifiedBy, contentWarnings, ...wirePayload } = pack;

    // Generate graphnosisMd from recipes if not explicitly provided
    if (!wirePayload.graphnosisMd) {
      wirePayload.graphnosisMd = generateGraphnosisMd(wirePayload);
    }

    wirePayload.formatVersion = '1';
    wirePayload.signature = '';

    const bytes = buildGtsPackage(wirePayload, signingKey);
    const outPath = join(OUT_DIR, `${pack.id}.gts`);
    const ws = createWriteStream(outPath);
    await new Promise((res, rej) => {
      ws.end(bytes, err => err ? rej(err) : res());
    });

    const signed = SIGN ? ' (signed)' : ' (unsigned/community)';
    console.log(`  wrote ${outPath}  [${bytes.length} bytes]${signed}`);
  }

  console.log(`\n✓ ${packs.length} pack(s) compiled successfully.`);
  console.log('  Remember: dist/packs/ is gitignored. Transfer binaries out-of-band.');
}

// ── graphnosisMd generator ────────────────────────────────────────────────────

function generateGraphnosisMd(pack) {
  const lines = [
    `# Graphnosis Memory — ${pack.displayName}`,
    '',
    `> Pack: ${pack.id} v${pack.version} · ${pack.author}`,
    '',
  ];

  for (const skill of pack.skills) {
    lines.push(`## ${skill.name}`, '');
    for (const recipe of skill.recallRecipes) {
      lines.push(`### ${recipe.name}`);
      lines.push(`Trigger: ${recipe.trigger}`, '');
      lines.push('Steps:');
      for (const step of recipe.steps) {
        let line = `  - \`${step.tool}\` — query: "${step.query}"`;
        if (step.onlyEngrams?.length) line += ` (engrams: ${step.onlyEngrams.join(', ')})`;
        if (step.ifResultsBelow != null) line += ` [only if previous < ${step.ifResultsBelow} nodes]`;
        lines.push(line);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

main().catch(err => {
  console.error('\n✗ Unexpected error:', err);
  process.exit(1);
});
