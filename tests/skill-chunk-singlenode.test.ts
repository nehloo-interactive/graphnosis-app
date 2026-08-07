// Regression: a single numbered skill step must become EXACTLY ONE stored
// node — never fragmented across a sentence boundary the SDK's chunker
// mis-detects.
//
// Root cause: host.insertNodeAt → adapter.appendDocument runs the step text
// through the SDK's appendText, which re-chunks on sentence/char granularity.
// A step ending in an abbreviation period ("…letters of support, etc.) and
// verify…") tripped the splitter and got stored as two nodes — one ending at
// "…etc." and the next STARTING with ") and verify…".
//
// Fix: skill-source inserts pass `singleNode: true`, which makes the adapter
// collapse the SDK's output to one node carrying the verbatim step text. This
// suite trains a real skill through a live cortex and asserts each numbered
// step maps to exactly one node with byte-identical content. It also
// unit-tests splitSentences() against the abbreviation / code / decimal cases
// (the memory-placement coherence path).

import {
  SkillTrainer,
  splitSentences,
  splitBodyRunIntoUnits,
} from '../apps/desktop-sidecar/src/skill-trainer.js';
import { setupTestCortex, assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

// Numbered steps deliberately stress every fragmentation trap:
//   step 1 — "(501c3, 990, etc.) and verify"  → abbreviation + code tokens
//   step 2 — "e.g." mid-sentence              → abbreviation
//   step 3 — "i.e." + decimal "3.5"           → abbreviation + decimal
//   step 4 — quoted "done" + @needs tag       → quotes + routing tag survive
const STEPS = [
  '1. Assemble the attachments checklist (501c3 letter, 990, audited financials, board list, letters of support, etc.) and verify each exists and is current before the narrative is "done". @needs: fast',
  '2. Draft the executive summary first, then expand each section (e.g. need, approach, budget) into full prose so the reviewer reads top-down.',
  '3. Confirm the budget reconciles (i.e. line items sum to the requested total) and round every figure to 3.5 percent overhead, no more.',
  '4. Mark the proposal "done" only after a second reader signs off on tone and completeness. @needs: reasoning',
];

const SKILL_TEXT = [
  'Trigger: A grant proposal needs drafting.',
  'Success: A complete, reviewer-ready proposal. [verify: human]',
  '',
  STEPS[0],
  '',
  STEPS[1],
  '',
  STEPS[2],
  '',
  STEPS[3],
].join('\n');

async function singleNodeSuite(): Promise<void> {
  // ── Part A: full-cortex train → one node per step ─────────────────────────
  section('train_skill — each numbered step is stored as EXACTLY ONE node');
  const cx = await setupTestCortex('skill-singlenode');
  try {
    const graphId = 'docs'; // reuse a personal-tier engram as the skills engram
    await cx.host.createGraph(graphId);
    const trainer = new SkillTrainer(cx.host, null); // null LLM → verbatim body

    const result = await trainer.trainSkill({
      skill: SKILL_TEXT,
      skillName: 'grant-proposal-drafting',
      graphId,
      save: true,
      addedBy: 'test:skill-singlenode',
    });

    assert(!!result.skillId, 'trainSkill returned a skillId', result.skillId);
    const sourceId = result.skillId!;

    const rec = cx.host.getSourceRecord(graphId, sourceId);
    assert(!!rec, 'skill source record exists', sourceId);

    // Map nodeId → full content for every node in the engram.
    const byId = new Map<string, string>();
    for (const n of cx.host.listNodes(graphId)) byId.set(n.id, n.contentPreview);

    // Pull this source's node contents in order.
    const nodeTexts = (rec!.nodeIds ?? []).map((id) => byId.get(id) ?? '');

    // For each numbered step, exactly one stored node must contain it verbatim,
    // and no node may be a fragment (a node that contains only PART of a step —
    // e.g. one starting with ") and verify" or ending mid-step at "etc.").
    for (let i = 0; i < STEPS.length; i++) {
      const step = STEPS[i]!;
      const exactMatches = nodeTexts.filter((t) => t === step);
      assert(
        exactMatches.length === 1,
        `step ${i + 1} stored as exactly one verbatim node`,
        { expected: step, matchCount: exactMatches.length, nodeTexts },
      );
    }

    // No node may be a proper fragment of a step (substring but not equal).
    // This catches the ") and verify…" split form directly.
    const fragments = nodeTexts.filter((t) =>
      t.length > 0 &&
      STEPS.some((step) => step !== t && (step.includes(t) || t.startsWith(') and verify'))),
    );
    assert(fragments.length === 0, 'no step was fragmented across nodes', fragments);

    // Verbatim integrity of the load-bearing trap step (parens, "etc.", quotes,
    // @needs tag all preserved byte-for-byte).
    const trap = nodeTexts.find((t) => t.startsWith('1. Assemble'));
    assert(trap === STEPS[0], 'trap step preserved verbatim (parens, etc., quotes, @needs)', trap);
  } finally {
    await cx.cleanup();
  }

  // ── Part B: splitSentences() abbreviation / code / decimal hardening ───────
  section('splitSentences — does not split on abbreviations, codes, or decimals');

  // Abbreviation periods are NOT sentence boundaries — the whole thing stays
  // as one sentence even when followed by a capitalized word.
  const etc = splitSentences('Gather the 501c3 letter, 990, etc. Then verify each item.');
  assert(etc.length === 1, '"etc." period is not a sentence boundary', etc);
  assert(etc[0]!.includes('etc. Then'), '"etc." kept attached to following clause', etc);

  const eg = splitSentences('Expand each section (e.g. Need, Approach) into prose.');
  assert(eg.length === 1, '"e.g." mid-sentence does not split', eg);

  const ie = splitSentences('Confirm the budget reconciles (i.e. Items sum to the total).');
  assert(ie.length === 1, '"i.e." does not split before a capitalized word', ie);

  // Decimals never split (next char isn't uppercase), and the abbreviation
  // guard also protects the digit-token case.
  const dec = splitSentences('Round to 3.5 percent overhead. Then stop.');
  assert(dec.length === 2, 'decimal "3.5" stays whole; the real boundary still splits', dec);
  assert(dec[0]!.includes('3.5'), 'decimal kept intact in first sentence', dec);

  // A code token like "990" before a period is treated as an abbreviation-like
  // boundary suppressor (it is rarely a true sentence end in skill steps).
  const code = splitSentences('Attach the 990. File the 501c3 letter.');
  assert(code.length === 1, 'digit/code token before period does not split', code);

  const plain = splitSentences('First sentence here. Second sentence here. Third one.');
  assert(plain.length === 3, 'plain prose still splits on every real boundary', plain);

  // ── Part C: splitBodyRunIntoUnits — single-newline steps split per step ─────
  section('splitBodyRunIntoUnits — one unit per numbered step / bullet, recipes whole');

  // Steps separated by SINGLE newlines (no blank line) → one unit each.
  const singleNl = splitBodyRunIntoUnits([
    '1. First step does a thing.',
    '2. Second step does another thing.',
    '3. Third step finishes up.',
  ]);
  assert(singleNl.length === 3, 'three single-newline steps yield three units', singleNl);
  assert(singleNl[0] === '1. First step does a thing.', 'step 1 verbatim', singleNl);
  assert(singleNl[2] === '3. Third step finishes up.', 'step 3 verbatim', singleNl);

  // A wrapped continuation line stays with its step.
  const wrapped = splitBodyRunIntoUnits([
    '1. Gather the documents',
    '   and verify each one exists.',
    '2. Submit the package.',
  ]);
  assert(wrapped.length === 2, 'wrapped continuation stays attached to its step', wrapped);
  assert(wrapped[0]!.includes('verify each one'), 'continuation merged into step 1', wrapped);

  // Bullets each become their own unit too.
  const bullets = splitBodyRunIntoUnits(['- alpha', '- beta', '* gamma']);
  assert(bullets.length === 3, 'three bullets yield three units', bullets);

  // Abbreviation / code / decimal traps in single-newline steps stay one unit
  // each (no mid-step fragmentation): "etc.)", "e.g.", "990", and a decimal.
  const traps = splitBodyRunIntoUnits([
    '1. Assemble the checklist (501c3, 990, etc.) and verify each item exists.',
    '2. Expand each section (e.g. need, approach) into prose.',
    '3. Round every figure to 3.5 percent overhead, no more.',
  ]);
  assert(traps.length === 3, 'trap steps still split per step, never mid-step', traps);
  assert(traps[0]!.includes('etc.) and verify'), 'step with "etc.)" kept whole', traps);
  assert(traps[1]!.includes('e.g. need'), 'step with "e.g." kept whole', traps);
  assert(traps[2]!.includes('3.5 percent'), 'step with decimal "3.5" kept whole', traps);
  assert(
    traps.every((u) => /^\d+\.\s/.test(u)),
    'every unit begins exactly at a step number (no fragments)',
    traps,
  );

  // A recall-recipe block (header + step bullets) stays a SINGLE unit — its
  // bullets are not split off as free-standing bullets.
  const recipe = splitBodyRunIntoUnits([
    '1. Do the first thing.',
    'sponsor-recall: when a sponsor is mentioned',
    '- recall: prior sponsor terms',
    '- recall: vendor pricing history',
    '2. Do the second thing.',
  ]);
  assert(recipe.length === 3, 'recipe header+bullets collapse to one unit', recipe);
  assert(
    recipe[1]!.includes('sponsor-recall:') && recipe[1]!.includes('- recall: vendor pricing'),
    'recipe block kept intact (header + all step bullets)',
    recipe,
  );
}

// Part D: full-cortex train — single-newline steps + slug-only first line.
async function singleNewlineTrainSuite(): Promise<void> {
  section('train_skill — single-newline steps split per node; slug-only first line dropped');
  const cx = await setupTestCortex('skill-singlenewline');
  try {
    const graphId = 'docs';
    await cx.host.createGraph(graphId);
    const trainer = new SkillTrainer(cx.host, null); // null LLM → verbatim body

    // First body line is just the skill's kebab slug (junk); the steps that
    // follow are separated only by single newlines (the bug's trigger).
    const NL_STEPS = [
      '1. Open the sponsor brief and confirm the budget (e.g. line items, 990 totals, etc.) reconciles.',
      '2. Draft the counter-offer, rounding overhead to 3.5 percent, no more.',
      '3. Send for a second reader to mark it "done".',
    ];
    const skillText = [
      'sponsor-and-vendor-negotiation', // slug-only junk first line
      ...NL_STEPS,                       // steps, single newlines between them
    ].join('\n');

    const result = await trainer.trainSkill({
      skill: skillText,
      skillName: 'sponsor-and-vendor-negotiation',
      graphId,
      save: true,
      addedBy: 'test:skill-singlenewline',
    });
    assert(!!result.skillId, 'trainSkill returned a skillId', result.skillId);
    const sourceId = result.skillId!;

    const rec = cx.host.getSourceRecord(graphId, sourceId);
    assert(!!rec, 'skill source record exists', sourceId);

    const byId = new Map<string, string>();
    for (const n of cx.host.listNodes(graphId)) byId.set(n.id, n.contentPreview);
    const nodeTexts = (rec!.nodeIds ?? []).map((id) => byId.get(id) ?? '');

    // (a) one node per step, even with single newlines between them.
    for (let i = 0; i < NL_STEPS.length; i++) {
      const step = NL_STEPS[i]!;
      const exact = nodeTexts.filter((t) => t === step);
      assert(
        exact.length === 1,
        `single-newline step ${i + 1} stored as exactly one node`,
        { expected: step, matchCount: exact.length, nodeTexts },
      );
    }

    // (b) the slug-only first line was dropped (no node equals the slug).
    const slugNodes = nodeTexts.filter((t) => t === 'sponsor-and-vendor-negotiation');
    assert(slugNodes.length === 0, 'slug-only first line dropped (not stored as a node)', nodeTexts);

    // (c) the trap step (etc.) / e.g. / 990 / decimal) stayed one node.
    const trap = nodeTexts.find((t) => t.startsWith('1. Open the sponsor'));
    assert(trap === NL_STEPS[0], 'trap step preserved verbatim (etc., e.g., 990, decimal)', trap);
  } finally {
    await cx.cleanup();
  }
}

async function suite(): Promise<void> {
  await singleNodeSuite();
  await singleNewlineTrainSuite();
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-chunk-singlenode', suite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-chunk-singlenode', suite);
