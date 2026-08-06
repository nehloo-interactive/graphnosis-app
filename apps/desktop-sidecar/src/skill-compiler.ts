/**
 * Agempus skill compiler — the deterministic layer under `train_skill`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now `train_skill` never produced the Agempus format; it only *parsed*
 * structure that the author had already written. Prose in, prose out. A caller
 * who pasted a perfectly good procedure with no `Trigger:` / `Success:` lines
 * got a saved skill with a 0/8 contract, no error, and no signal that the
 * result would never dispatch. The optional local-LLM path did not help — its
 * prompt is a *preserving* copy-editor (see skill-sop-rewrite.ts), explicitly
 * forbidden from inventing tokens the source lacked.
 *
 * This module is the honest floor. It runs with no LLM, no network and no
 * cortex recall:
 *
 *   L0  scaffoldAgempus()  — normalize prose into Agempus SHAPE. Reorders and
 *                            renumbers; never invents semantics. Missing
 *                            contract fields become explicit placeholders.
 *   ——  assessAgempus()    — score the result against the 8-field contract and
 *                            the routing tags, so the gap is a number, not a
 *                            vibe.
 *   ——  traceCoverage()    — deterministic fidelity check, both directions:
 *                            what did the compile DROP from the source, and
 *                            what did it INVENT that the source never said.
 *
 * L1 (the caller loop) lives in mcp-server.ts: when the score is below the bar
 * the tool returns this scaffold plus the gap report INSTEAD of saving, and the
 * calling agent — which wrote the prose and is the strongest model in the room
 * — fills the contract and calls again. `CompileLoopTracker` bounds that at
 * MAX_COMPILE_ROUNDS so a client that cannot converge still lands a skill.
 *
 * PRIVACY INVARIANT
 * -----------------
 * Everything here operates on the caller-supplied skill text only. No engram
 * content enters this module, so handing the scaffold back to a cloud-hosted
 * caller discloses nothing the caller did not already send us. That holds only
 * while skill-trainer's ENABLE_CORTEX_RECALL_AT_TRAIN stays false — if
 * train-time recall is ever switched on, the caller loop must be disabled in
 * the same commit. tests/skill-compiler.test.mjs pins that invariant.
 */

// ── The contract ──────────────────────────────────────────────────────────────

export type ContractField =
  | 'Trigger'
  | 'Prerequisites'
  | 'Requires'
  | 'Produces'
  | 'Success'
  | 'Out of scope'
  | 'On failure'
  | 'On completion';

/**
 * Canonical order. Authoring order in the body is presentational — walk_skill
 * and export both extract goals by category — but a stable order keeps diffs
 * readable and makes retrains idempotent.
 */
export const CONTRACT_FIELDS: readonly ContractField[] = [
  'Trigger',
  'Prerequisites',
  'Requires',
  'Produces',
  'Success',
  'Out of scope',
  'On failure',
  'On completion',
] as const;

/** One-line prompts shown to the caller for each unfilled field. */
const FIELD_HINTS: Record<ContractField, string> = {
  'Trigger':       'when should an agent invoke this skill on its own? Name the observable situation, not the intent.',
  'Prerequisites': 'what must already be true before step 1 can run?',
  'Requires':      'named inputs from the caller, as comma-separated $camelCase vars (or "none").',
  'Produces':      'named outputs this skill makes available to callers, as $camelCase vars (or "none").',
  'Success':       'what does a correct finish look like? End with a [verify: tool|state|human] oracle.',
  'Out of scope':  'what must this skill NOT attempt, so it hands off instead of guessing?',
  'On failure':    'recovery path when a step throws — may reference a recovery skill via @skill: name.',
  'On completion': 'what tangible artifact or state exists once this has run?',
};

/** Placeholder value written for a field the author never supplied. */
const PLACEHOLDER_PREFIX = 'TODO';

/** A contract value that is really an unfilled placeholder. */
const PLACEHOLDER_RE = /^\s*(?:TODO|TBD|\?{2,}|—|-)\s*(?:—|-|:)?\s*/i;

/**
 * Matches a contract line in plain body form: `Success: …`.
 * Anchored at line start (after indentation) — the same shape
 * skill-trainer's goalRoleForLine() classifies into goal nodes, so scaffolded
 * output flows through the existing chunker with no special casing.
 */
const CONTRACT_LINE_RE =
  /^\s*(Trigger|Prerequisites|Requires|Produces|Success|Out of scope|On failure|On completion)\s*:\s*(.*)$/i;

/**
 * Matches a contract line in *rendered walk* form:
 *   `- ✓ **Success:** …`
 * walk_skill emits this, so users paste it back when iterating on a skill.
 * Accepting it makes a round-trip lossless instead of duplicating every field.
 */
const RENDERED_CONTRACT_LINE_RE =
  /^\s*[-*•]\s*(?:[⚡◆▹✓✗↺⊕]\s*)?\*{0,2}(Trigger|Prerequisites|Requires|Produces|Success|Out of scope|On failure|On completion)\s*:?\*{0,2}\s*:?\s*(.*)$/i;

/** `1. step` / `2) step` — an already-numbered sequence line. */
const NUMBERED_STEP_RE = /^\s*(\d+)[.)]\s+(\S.*)$/;

/** `- step` / `* step` / `• step` at column 0 — a candidate step. */
const TOP_BULLET_RE = /^[-*•]\s+(\S.*)$/;

/** The authored dispatch cap. */
const DISPATCH_SAFE_RE = /^\s*\[dispatch-safe:\s*([a-z]+)\s*\]\s*$/i;

/** Per-step model-routing tag. */
const NEEDS_TAG_RE = /@needs?:/i;

/** Cross-skill call / loop / branch / parallel markers. */
const STRUCTURE_TAG_RE = /@(?:skill|loop|branch|parallel)\s*:/i;

/** The training metadata comment skill-trainer prepends on save. */
const METADATA_BLOCK_RE = /<!--\s*Graphnosis skill training metadata[\s\S]*?-->/g;

/** A `## Goals` heading introducing the rendered contract block. */
const GOALS_HEADING_RE = /^\s*#{1,6}\s*Goals\s*$/i;

/** Any markdown heading. */
const HEADING_RE = /^\s*(#{1,6})\s+(\S.*)$/;

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!PLACEHOLDER_RE.test(trimmed)) return false;
  // `TODO` alone, or `TODO — hint`. A field whose real value merely *starts*
  // with the word (unlikely, but "TODO items are tracked in…") is still a
  // placeholder by this rule; that is the safe direction to be wrong in — it
  // asks the caller for one more pass rather than silently accepting filler.
  return true;
}

function normalizeField(raw: string): ContractField | null {
  const key = raw.trim().toLowerCase();
  for (const f of CONTRACT_FIELDS) {
    if (f.toLowerCase() === key) return f;
  }
  return null;
}

// ── Assessment ────────────────────────────────────────────────────────────────

export interface ContractEntry {
  field: ContractField;
  /** True when a line for this field exists AND carries a real value. */
  filled: boolean;
  /** The authored value, absent when the field is missing or a placeholder. */
  value?: string;
}

export interface AgempusConformance {
  /** Contract fields carrying a real value, 0–8. */
  score: number;
  maxScore: 8;
  contract: ContractEntry[];
  /** Fields that are missing outright or hold a placeholder. */
  missing: ContractField[];
  /** True when the body carries a `[dispatch-safe: …]` cap. */
  hasDispatchSafe: boolean;
  dispatchSafe?: string;
  /** True when a title line was found. */
  hasTitle: boolean;
  title?: string;
  /** Numbered sequence steps. */
  stepCount: number;
  /** Steps carrying an `@needs:` routing tag. */
  stepsWithNeeds: number;
  /** Steps carrying `@skill:` / `@loop:` / `@branch:` / `@parallel:`. */
  stepsWithStructure: number;
  /** Human-readable problems, most structural first. */
  issues: string[];
  /** True when this is good enough to save without another caller pass. */
  conforms: boolean;
}

/**
 * The bar for `conforms`. Deliberately not 8/8: `Out of scope` and
 * `On failure` are genuinely optional for simple linear procedures, and
 * demanding perfection would loop forever on skills that do not need it.
 * A skill that clears this bar dispatches correctly; the rest is polish.
 */
export const CONFORMANCE_THRESHOLD = 6;

/** Contract fields without which dispatch is unsafe or meaningless. */
const REQUIRED_FIELDS: readonly ContractField[] = ['Trigger', 'Success'] as const;

export function assessAgempus(text: string): AgempusConformance {
  const parsed = parseSkillText(text);
  const contract: ContractEntry[] = CONTRACT_FIELDS.map((field) => {
    const value = parsed.contract.get(field);
    if (value === undefined || isPlaceholderValue(value)) return { field, filled: false };
    return { field, filled: true, value };
  });
  const missing = contract.filter((c) => !c.filled).map((c) => c.field);
  const score = contract.length - missing.length;

  const issues: string[] = [];
  if (parsed.steps.length === 0) {
    issues.push(
      'no numbered sequence — the body is prose, so there is nothing for an agent to walk step by step',
    );
  }
  for (const f of REQUIRED_FIELDS) {
    if (missing.includes(f)) {
      issues.push(`\`${f}:\` is missing — ${FIELD_HINTS[f]}`);
    }
  }
  const otherMissing = missing.filter((f) => !REQUIRED_FIELDS.includes(f));
  if (otherMissing.length > 0) {
    issues.push(`${otherMissing.length} more contract field(s) unfilled: ${otherMissing.join(', ')}`);
  }
  if (parsed.steps.length > 0 && parsed.stepsWithNeeds === 0) {
    issues.push(
      'no `@needs:` routing tags — every step will be routed to the default model instead of the cheapest one that can do it',
    );
  }
  if (!parsed.title) {
    issues.push('no title line');
  }
  if (parsed.dispatchSafe === undefined) {
    // Reported, not enforced: an absent tag already means `yes`, so this is
    // load-bearing information rather than a nit — but injecting a cap would
    // change autonomy behavior behind the author's back.
    issues.push(
      'no `[dispatch-safe: yes|partial|no]` cap — an absent tag means `yes`, so this skill is ' +
      'eligible for unattended L3 dispatch. Add an explicit cap.',
    );
  }

  const conforms =
    score >= CONFORMANCE_THRESHOLD &&
    REQUIRED_FIELDS.every((f) => !missing.includes(f)) &&
    parsed.steps.length > 0;

  return {
    score,
    maxScore: 8,
    contract,
    missing,
    hasDispatchSafe: parsed.dispatchSafe !== undefined,
    ...(parsed.dispatchSafe !== undefined ? { dispatchSafe: parsed.dispatchSafe } : {}),
    hasTitle: parsed.title !== undefined,
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    stepCount: parsed.steps.length,
    stepsWithNeeds: parsed.stepsWithNeeds,
    stepsWithStructure: parsed.stepsWithStructure,
    issues,
    conforms,
  };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * One unit of skill body, in authored order.
 *
 * Steps and prose share a single ordered stream on purpose. An earlier draft
 * split them into separate arrays and re-emitted prose first — which silently
 * hoisted every trailing note (a closing "ENGRAM MAP", a "PRAXIS LOOP" block)
 * above the numbered sequence. Content survived; meaning did not. Retraining
 * the existing skill library would have scrambled all of them at once.
 */
export interface BodyUnit {
  kind: 'step' | 'text';
  /** For a step, the text WITHOUT its leading number — it gets renumbered. */
  text: string;
}

interface ParsedSkill {
  /** Preserved verbatim, re-emitted at the very top. */
  metadataBlocks: string[];
  dispatchSafe?: string;
  title?: string;
  /** field → raw value (may be a placeholder). */
  contract: Map<ContractField, string>;
  /** The body in authored order, steps marked in place. */
  body: BodyUnit[];
  /** Convenience view: just the step texts, in order. */
  steps: string[];
  stepsWithNeeds: number;
  stepsWithStructure: number;
}

/**
 * Split a skill body into its Agempus parts. Lossless by construction: every
 * input line lands in exactly one bucket, so `scaffoldAgempus` can reassemble
 * without dropping content. That is what makes the coverage trace meaningful —
 * a drop is a real bug, not a parser artifact.
 */
export function parseSkillText(text: string): ParsedSkill {
  const metadataBlocks: string[] = [];
  const withoutMetadata = text.replace(METADATA_BLOCK_RE, (m) => {
    metadataBlocks.push(m.trim());
    return '';
  });

  const contract = new Map<ContractField, string>();
  const body: BodyUnit[] = [];
  let dispatchSafe: string | undefined;
  let title: string | undefined;
  let stepsWithNeeds = 0;
  let stepsWithStructure = 0;
  let inGoalsSection = false;

  const lines = withoutMetadata.split('\n');
  let stepCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (body.length > 0 && body[body.length - 1]!.text !== '') {
        body.push({ kind: 'text', text: '' });
      }
      continue;
    }

    const ds = DISPATCH_SAFE_RE.exec(trimmed);
    if (ds) {
      dispatchSafe = ds[1]!.toLowerCase();
      continue;
    }

    if (GOALS_HEADING_RE.test(trimmed)) {
      // Everything under `## Goals` is the rendered contract; entering the
      // section lets us accept its bullets without treating them as steps.
      inGoalsSection = true;
      continue;
    }

    const plain = CONTRACT_LINE_RE.exec(line);
    if (plain) {
      const field = normalizeField(plain[1]!);
      // First writer wins: an authored value earlier in the body is not
      // clobbered by a rendered duplicate further down.
      if (field && !contract.has(field)) contract.set(field, plain[2]!.trim());
      else if (field && isPlaceholderValue(contract.get(field)!) && !isPlaceholderValue(plain[2]!)) {
        contract.set(field, plain[2]!.trim());
      }
      continue;
    }

    const rendered = RENDERED_CONTRACT_LINE_RE.exec(line);
    if (rendered) {
      const field = normalizeField(rendered[1]!);
      if (field) {
        const value = rendered[2]!.trim();
        if (!contract.has(field)) contract.set(field, value);
        else if (isPlaceholderValue(contract.get(field)!) && !isPlaceholderValue(value)) {
          contract.set(field, value);
        }
        continue;
      }
    }

    if (inGoalsSection) {
      // A non-contract line inside `## Goals` ends the section — the rendered
      // block is contiguous.
      if (TOP_BULLET_RE.test(trimmed)) continue;
      inGoalsSection = false;
    }

    const numbered = NUMBERED_STEP_RE.exec(line);
    if (numbered) {
      const stepText = numbered[2]!.trim();
      body.push({ kind: 'step', text: stepText });
      stepCount++;
      if (NEEDS_TAG_RE.test(stepText)) stepsWithNeeds++;
      if (STRUCTURE_TAG_RE.test(stepText)) stepsWithStructure++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading && title === undefined && stepCount === 0) {
      title = heading[2]!.trim();
      continue;
    }

    // First substantive non-step line becomes the title when no heading exists.
    if (
      title === undefined &&
      stepCount === 0 &&
      contract.size === 0 &&
      body.length === 0 &&
      trimmed.length <= 120 &&
      !TOP_BULLET_RE.test(trimmed) &&
      !trimmed.endsWith('.')
    ) {
      title = trimmed;
      continue;
    }

    body.push({ kind: 'text', text: line });
  }

  // A step continued onto later lines lands as adjacent 'text'; that is
  // acceptable — it stays in place in the output, it simply is not counted as
  // a separate step.
  while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();

  return {
    metadataBlocks,
    ...(dispatchSafe !== undefined ? { dispatchSafe } : {}),
    ...(title !== undefined ? { title } : {}),
    contract,
    body,
    steps: body.filter((u) => u.kind === 'step').map((u) => u.text),
    stepsWithNeeds,
    stepsWithStructure,
  };
}

// ── L0: the deterministic scaffolder ──────────────────────────────────────────

export interface ScaffoldOptions {
  /** Used as the title when the source has none. */
  skillName?: string;
  /** Emit `TODO — hint` lines for unfilled fields. Default true. */
  includePlaceholders?: boolean;
}

export interface ScaffoldResult {
  text: string;
  /** True when the scaffold differs from the input in more than whitespace. */
  changed: boolean;
  /** What the scaffolder did, one bullet per action. */
  notes: string[];
}

/**
 * Normalize arbitrary prose into Agempus SHAPE.
 *
 * Hard rule: this never invents semantics. It reorders, renumbers, and marks
 * gaps. It will not guess a `Trigger:` from the prose, because a wrong Trigger
 * fires the skill on the wrong context — strictly worse than a missing one,
 * which fails loudly and visibly. Inferring meaning is the caller loop's job.
 *
 * What it WILL do deterministically:
 *   • hoist an existing `[dispatch-safe: …]` tag, or add a conservative one
 *   • promote a title
 *   • gather contract lines from either plain or rendered form into one block
 *     in canonical order, preserving authored values verbatim
 *   • renumber a bullet list into a numbered sequence (bullets are steps in
 *     nearly every SOP anyone writes)
 *   • mark every unfilled contract field with an explicit hinted placeholder
 */
export function scaffoldAgempus(text: string, opts: ScaffoldOptions = {}): ScaffoldResult {
  const { skillName, includePlaceholders = true } = opts;
  const notes: string[] = [];
  const parsed = parseSkillText(text);

  // ── Steps: promote top-level bullets when there is no numbered sequence ────
  // Promotion happens IN PLACE — a bullet becomes a step exactly where it was
  // written, so surrounding prose keeps its relationship to it.
  let body = parsed.body;
  if (parsed.steps.length === 0) {
    const bulletCount = body.filter((u) => u.kind === 'text' && TOP_BULLET_RE.test(u.text)).length;
    // One bullet is a sentence with a dash in front of it; two or more is a list.
    if (bulletCount >= 2) {
      body = body.map((u) => {
        if (u.kind !== 'text') return u;
        const m = TOP_BULLET_RE.exec(u.text);
        return m ? { kind: 'step' as const, text: m[1]!.trim() } : u;
      });
      notes.push(`Promoted ${bulletCount} top-level bullets into a numbered sequence.`);
    }
  }

  const title = parsed.title ?? skillName;
  if (!parsed.title && skillName) notes.push('Added a title line from the skill name.');

  // The cap is REPORTED, never injected.
  //
  // An earlier draft wrote `[dispatch-safe: no]` whenever the source lacked a
  // tag, reasoning that a machine-shaped skill should not reach L3. Two things
  // make that wrong. parseDispatchSafe() treats an absent tag as `yes`, so
  // injecting `no` would silently demote every untagged skill in an existing
  // library the moment it was retrained — an autonomy change smuggled inside a
  // formatting change. And the added line becomes its own body node, shifting
  // every downstream step index (the golden walks caught exactly this).
  //
  // Instead the gap is surfaced here and in the compile guidance, so the CALLER
  // authors an explicit cap. A human-reviewed tag beats a machine-guessed one.
  const dispatchSafe = parsed.dispatchSafe;
  if (!parsed.dispatchSafe) {
    notes.push(
      'No `[dispatch-safe: …]` tag — this skill is treated as `yes` (eligible for ' +
      'unattended dispatch at L3). Add an explicit cap if that is not intended.',
    );
  }

  // ── Contract block, canonical order ───────────────────────────────────────
  const contractLines: string[] = [];
  const placeheld: ContractField[] = [];
  for (const field of CONTRACT_FIELDS) {
    const raw = parsed.contract.get(field);
    if (raw !== undefined && !isPlaceholderValue(raw)) {
      contractLines.push(`${field}: ${raw}`);
    } else if (includePlaceholders) {
      contractLines.push(`${field}: ${PLACEHOLDER_PREFIX} — ${FIELD_HINTS[field]}`);
      placeheld.push(field);
    }
  }
  if (placeheld.length > 0) {
    notes.push(`Marked ${placeheld.length} unfilled contract field(s) with a hinted TODO.`);
  }

  // ── Reassemble ────────────────────────────────────────────────────────────
  const out: string[] = [];
  for (const block of parsed.metadataBlocks) {
    out.push(block, '');
  }
  if (title) out.push(title, '');
  if (dispatchSafe) out.push(`[dispatch-safe: ${dispatchSafe}]`, '');

  if (contractLines.length > 0) {
    out.push(...contractLines, '');
  }

  // The body is emitted in AUTHORED order, steps renumbered in place. Prose
  // that closes a skill stays at the end where its author put it.
  let stepNo = 0;
  for (const unit of trimBlankUnits(body)) {
    if (unit.kind === 'step') out.push(`${++stepNo}. ${unit.text}`);
    else out.push(unit.text);
  }

  const result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return {
    text: result,
    changed: normalizeWhitespace(result) !== normalizeWhitespace(text),
    notes,
  };
}

/**
 * Drop unfilled placeholder contract lines. Called immediately before persist
 * so an unconverged loop leaves a body with N/8 honest fields rather than one
 * padded with TODO filler that lints as present.
 */
export function stripPlaceholders(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const m = CONTRACT_LINE_RE.exec(line);
      if (!m) return true;
      return !isPlaceholderValue(m[2]!);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function trimBlankUnits(units: BodyUnit[]): BodyUnit[] {
  const out = [...units];
  while (out.length > 0 && out[0]!.text.trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1]!.text.trim() === '') out.pop();
  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Coverage tracing — the fidelity check ─────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in',
  'on', 'at', 'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'you', 'your',
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}$@_-]+/u)) {
    const t = raw.trim();
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Below this, two lines are considered unrelated. */
const COVERAGE_FLOOR = 0.35;

/** Lines with fewer content words than this are too short to trace reliably. */
const MIN_TRACE_TOKENS = 4;

export interface CoverageReport {
  /** Source lines with no counterpart in the compiled skill — dropped content. */
  dropped: string[];
  /** Compiled lines with no counterpart in the source — invented content. */
  invented: string[];
  /** 0–1: share of traceable source lines that survived. */
  retention: number;
  ok: boolean;
}

/**
 * Deterministic two-way fidelity check between authored source and compiled
 * skill.
 *
 * Chosen over an LLM judge on purpose: a judge is expensive, non-deterministic,
 * and gameable by the very model whose output it grades. Token overlap is none
 * of those. It is cruder — a heavy paraphrase reads as a drop — which is why
 * the result is reported to the caller rather than used to hard-fail a compile.
 */
export function traceCoverage(source: string, compiled: string): CoverageReport {
  const traceable = (text: string): Array<{ line: string; tokens: Set<string> }> =>
    text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
      .filter(Boolean)
      // Placeholders are ours, not the author's — never trace them.
      .filter((l) => {
        const m = CONTRACT_LINE_RE.exec(l);
        return !m || !isPlaceholderValue(m[2]!);
      })
      .map((line) => ({ line, tokens: contentTokens(line) }))
      .filter((e) => e.tokens.size >= MIN_TRACE_TOKENS);

  const src = traceable(source);
  const cmp = traceable(compiled);

  const bestMatch = (
    tokens: Set<string>,
    pool: Array<{ tokens: Set<string> }>,
  ): number => pool.reduce((best, p) => Math.max(best, jaccard(tokens, p.tokens)), 0);

  const dropped = src.filter((s) => bestMatch(s.tokens, cmp) < COVERAGE_FLOOR).map((s) => s.line);
  const invented = cmp.filter((c) => bestMatch(c.tokens, src) < COVERAGE_FLOOR).map((c) => c.line);
  const retention = src.length === 0 ? 1 : (src.length - dropped.length) / src.length;

  return {
    dropped,
    invented,
    retention,
    ok: dropped.length === 0 && invented.length === 0,
  };
}

// ── L1: bounded caller loop ───────────────────────────────────────────────────

/**
 * How many times the tool will hand a skill back to the caller before saving
 * whatever it has. Three is the same cap the user's own convergence protocol
 * uses for expensive loops, and it matches how quickly a capable model
 * converges in practice: round 1 fills the contract, round 2 adds routing
 * tags, round 3 is the safety net.
 */
export const MAX_COMPILE_ROUNDS = 3;

interface LoopEntry {
  rounds: number;
  lastHash: string;
  touchedAt: number;
}

/** Entries older than this are dropped — a stalled loop must not pin memory. */
const LOOP_TTL_MS = 30 * 60 * 1000;
const LOOP_MAX_ENTRIES = 64;

/**
 * Tracks how many times a given skill has been handed back, so the loop
 * terminates even against a client that never converges.
 *
 * Deliberately in-memory and best-effort: a sidecar restart resets the count,
 * which costs at most one extra round. Persisting it would mean writing loop
 * bookkeeping into the cortex for a transient compile.
 */
export class CompileLoopTracker {
  private readonly entries = new Map<string, LoopEntry>();

  private static key(graphId: string, skillName: string | undefined): string {
    const name = (skillName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${graphId}::${name || 'unnamed'}`;
  }

  private static hash(text: string): string {
    // FNV-1a — enough to tell "the caller changed something" from "the caller
    // resent the identical text", which is all this is for.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  private sweep(now: number): void {
    for (const [k, v] of this.entries) {
      if (now - v.touchedAt > LOOP_TTL_MS) this.entries.delete(k);
    }
    while (this.entries.size > LOOP_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Record an attempt and report which round this is (1-based) and whether the
   * loop has been exhausted.
   *
   * Resending byte-identical text does not advance the round — it burns it.
   * A caller stuck in a retry loop hits the cap immediately instead of getting
   * three chances to send the same thing.
   */
  record(graphId: string, skillName: string | undefined, text: string): {
    round: number;
    exhausted: boolean;
    repeated: boolean;
  } {
    const now = Date.now();
    this.sweep(now);
    const key = CompileLoopTracker.key(graphId, skillName);
    const hash = CompileLoopTracker.hash(text);
    const prev = this.entries.get(key);
    if (!prev) {
      this.entries.set(key, { rounds: 1, lastHash: hash, touchedAt: now });
      return { round: 1, exhausted: false, repeated: false };
    }
    const repeated = prev.lastHash === hash;
    const rounds = repeated ? MAX_COMPILE_ROUNDS : prev.rounds + 1;
    this.entries.set(key, { rounds, lastHash: hash, touchedAt: now });
    return { round: rounds, exhausted: rounds >= MAX_COMPILE_ROUNDS, repeated };
  }

  /** Clear the loop for a skill that has been saved. */
  clear(graphId: string, skillName: string | undefined): void {
    this.entries.delete(CompileLoopTracker.key(graphId, skillName));
  }
}

// ── The gap report the caller loop reads ──────────────────────────────────────

export interface CompileGuidanceInput {
  conformance: AgempusConformance;
  coverage: CoverageReport;
  scaffold: ScaffoldResult;
  round: number;
  skillName?: string;
}

/**
 * Render the instruction block returned to the calling agent instead of a
 * saved skill. This IS the loop — there is no server-side model call anywhere
 * in the path. The caller already holds the prose and the strongest model in
 * the room; it needs the target format and a precise list of what is missing.
 */
export function buildCompileGuidance(input: CompileGuidanceInput): string {
  const { conformance, coverage, scaffold, round, skillName } = input;
  const remaining = MAX_COMPILE_ROUNDS - round;
  const out: string[] = [];

  out.push(`## Skill not saved yet — one more pass needed (round ${round} of ${MAX_COMPILE_ROUNDS})`);
  out.push('');
  out.push(
    `\`${skillName ?? 'This skill'}\` scores **${conformance.score}/8** on the Agempus contract ` +
    `(needs ${CONFORMANCE_THRESHOLD}/8 plus \`Trigger:\`, \`Success:\` and a numbered sequence). ` +
    `A skill below that bar will not dispatch and will not route — it would be stored as inert prose.`,
  );
  out.push('');

  out.push('### What is missing');
  for (const issue of conformance.issues) out.push(`- ${issue}`);
  out.push('');

  if (conformance.missing.length > 0) {
    out.push('### Fill these fields');
    for (const field of conformance.missing) {
      out.push(`- **${field}:** ${FIELD_HINTS[field]}`);
    }
    out.push('');
  }

  if (coverage.dropped.length > 0) {
    out.push('### ⚠ Content from your source did not survive the compile');
    out.push('Re-include these, or confirm they were intentionally dropped:');
    for (const line of coverage.dropped.slice(0, 8)) out.push(`- ${truncate(line, 160)}`);
    if (coverage.dropped.length > 8) out.push(`- …and ${coverage.dropped.length - 8} more`);
    out.push('');
  }
  if (coverage.invented.length > 0) {
    out.push('### ⚠ Lines with no basis in your source');
    out.push('These appear in the compiled skill but not in what you sent — remove or ground them:');
    for (const line of coverage.invented.slice(0, 8)) out.push(`- ${truncate(line, 160)}`);
    out.push('');
  }

  out.push('### The Agempus format');
  out.push('```');
  out.push('<Title>');
  out.push('');
  out.push('[dispatch-safe: yes|partial|no]');
  out.push('');
  out.push('Trigger: <observable situation that should invoke this>');
  out.push('Prerequisites: <what must be true before step 1>');
  out.push('Requires: $inputVar, $otherVar');
  out.push('Produces: $outputVar');
  out.push('Success: <correct finish> [verify: tool|state|human]');
  out.push('Out of scope: <what this must not attempt>');
  out.push('On failure: <recovery, may use @skill: recovery-skill>');
  out.push('On completion: <artifact or state that now exists>');
  out.push('');
  out.push('1. <step> @needs: <capability>');
  out.push('2. <step> @loop: 3 max=5');
  out.push('3. @skill: other-skill(arg=$inputVar) -> $result');
  out.push('```');
  out.push('');

  out.push('### Your draft, already scaffolded');
  out.push('Everything below is preserved from your source apart from ordering and the TODO lines.');
  out.push('');
  out.push('```markdown');
  out.push(scaffold.text.trimEnd());
  out.push('```');
  out.push('');

  out.push('### Next step');
  out.push(
    '**Call `train_skill` again** with `skill` set to the block above with every `TODO` replaced ' +
    'by a real value. Derive each field from the procedure itself — do not invent requirements ' +
    'the source does not support, and ask the user when a field is genuinely underdetermined.',
  );
  if (remaining <= 1) {
    out.push('');
    out.push(
      `_This is the last round. The next call saves whatever it receives, with any remaining ` +
      `TODO lines dropped rather than stored._`,
    );
  } else {
    out.push('');
    out.push(
      `_If a field stays genuinely underdetermined after ${remaining} more attempt(s), call again ` +
      `with \`accept_incomplete: true\` to save what you have._`,
    );
  }
  return out.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
