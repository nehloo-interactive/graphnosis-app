// Ghampus Proactive Watcher
//
// Runs on a timer (default 90s), scans for signals (recent ingestion, elapsed
// time since last quality check, etc.), and matches them against the skill
// library. High-confidence matches are surfaced as "proposed cards" that
// appear in the Ghampus chat thread — the user presses Run, Snooze, or
// Dismiss.
//
// Matching strategy: three-pass.
//   1. Skill-dispatch trigger lines (trained routing rules).
//   2. Keyword overlap between signal labels and skill name words.
//   3. Time-based rules for skills with no strong label signal (security
//      cadence, cortex gardening, skill maintenance review).
//
// Anti-spam: max 5 NEW cards per session; 6-hour suppression per
// {signalType, skillSourceId} pair; skill-dispatch itself is excluded
// from auto-proposal (meta-skill), but its trigger table drives matching.
//
// Dismiss/snooze state persists to `<cortex>/proactive-watcher-state.json`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';
import type { BroadcastRawFn } from './events.js';
import { listNotifications } from './agent-notifications.js';
import { extractDispatchTriggerLines, findSkillDispatchSourceId } from './skill-dispatch-sync.js';
import { matchDispatchTriggers } from './proactive-dispatch-match.js';
import { resolveGhampusProactiveSettings } from '@graphnosis-app/core/settings';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ProactiveCard {
  id: string;
  createdAt: number;
  /** What triggered this proposal. */
  signalType: 'recent-ingest' | 'time-based' | 'recall-pattern' | 'obligation-due';
  /** Human-readable description of the signal, shown in the card's "why" line. */
  signalLabel: string;
  /** The skill being proposed. */
  skillSourceId: string;
  skillGraphId: string;
  /** Display name (label with prefix stripped). */
  skillLabel: string;
  /** One-line reason shown to the user. */
  why: string;
  status: 'pending' | 'running' | 'snoozed' | 'dismissed' | 'done';
}

export interface ProactiveWatcherDeps {
  host: GraphnosisHost;
  skillTrainer: SkillTrainer | null;
  broadcastRaw: BroadcastRawFn;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TICK_MS           = 90_000;    // 90 seconds
const SUPPRESS_MS       = 6 * 60 * 60 * 1000;  // 6 hours per {signal, skill}
const MAX_CARDS_SESSION = 5;
const DEFAULT_STARTUP_DELAY_MS = 5 * 60_000;
const STATE_FILE = 'proactive-watcher-state.json';

interface PersistedWatcherState {
  suppressed?: Record<string, number>;
  lastTimeBasedProposal?: Record<string, number>;
  snoozedUntil?: Record<string, number>;
  dismissedSkills?: Record<string, number>;
}

async function loadWatcherState(cortexDir: string): Promise<PersistedWatcherState> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, STATE_FILE), 'utf8');
    return JSON.parse(raw) as PersistedWatcherState;
  } catch {
    return {};
  }
}

async function saveWatcherState(cortexDir: string, state: PersistedWatcherState): Promise<void> {
  await fs.writeFile(path.join(cortexDir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

// Meta-skills that should never be auto-proposed (they route to others).
const META_SKILLS = new Set([
  'skill-dispatch',
  'session-start',
  'session-end',
  'self-driving-session',
  'adaptive-skill-creation',
  'autonomous-decision-authority',
]);

// Keyword → skill-name fragments for matching.
// Keys are lowercased words that might appear in a source label or ref.
// Values are arrays of skill-label words (any match = score bump).
const KEYWORD_SKILL_MAP: Record<string, string[]> = {
  // Recent code changes / UI work
  'ui':      ['ux-review', 'ux-decision', 'consistency'],
  'ux':      ['ux-review', 'ux-decision', 'accessibility'],
  'css':     ['ux-review', 'consistency'],
  'html':    ['ux-review', 'accessibility'],
  'design':  ['ux-review', 'ux-decision', 'accessibility'],
  'layout':  ['ux-review', 'accessibility'],
  'theme':   ['ux-review', 'consistency'],
  'style':   ['ux-review', 'consistency'],
  'button':  ['ux-review', 'accessibility'],
  'modal':   ['ux-review', 'accessibility'],
  'view':    ['ux-review', 'ux-decision'],
  // Shipping / releases
  'ship':     ['ship-workflow', 'changelog', 'release-announcement'],
  'release':  ['ship-workflow', 'changelog', 'release-announcement'],
  'version':  ['ship-workflow', 'changelog'],
  'tag':      ['ship-workflow', 'changelog'],
  'deploy':   ['ship-workflow', 'deployment-platform'],
  'changelog': ['changelog-management'],
  'publish':  ['ship-workflow', 'release-announcement'],
  // Security
  'security': ['security-review'],
  'auth':     ['security-review', 'compliance'],
  'token':    ['security-review'],
  'secret':   ['security-review'],
  'key':      ['security-review'],
  'oauth':    ['security-review'],
  'ssl':      ['security-review'],
  'tls':      ['security-review'],
  // Bugs / issues
  'bug':      ['bug-investigation'],
  'error':    ['bug-investigation', 'runtime-diagnosis'],
  'crash':    ['bug-investigation', 'runtime-diagnosis'],
  'fix':      ['bug-investigation'],
  'issue':    ['bug-investigation'],
  'fail':     ['bug-investigation', 'testing-cadence'],
  // Performance
  'perf':     ['performance-regression'],
  'performance': ['performance-regression'],
  'slow':     ['performance-regression', 'runtime-diagnosis'],
  'latency':  ['performance-regression'],
  // Documentation / content
  'docs':     ['docs-maintenance', 'generated-artifact-freshness'],
  'readme':   ['docs-maintenance'],
  'content':  ['content-creation', 'docs-maintenance'],
  'article':  ['content-creation', 'website-copy'],
  // Enterprise / compliance
  'enterprise': ['enterprise-gtm', 'enterprise-sales', 'compliance'],
  'compliance': ['compliance-requirements', 'legal-review', 'enterprise-compliance'],
  'legal':    ['legal-review'],
  'gdpr':     ['compliance-requirements', 'legal-review'],
  // Product
  'feature':  ['feature-impact', 'feature-showcase', 'product-trajectory'],
  'product':  ['product-trajectory', 'product-ideation', 'feature-impact'],
  'roadmap':  ['product-trajectory', 'integration-roadmap'],
  // Skills / cortex health
  'skill':    ['skill-maintenance', 'skill-dispatch'],
  'cortex':   ['cortex-gardening', 'overlay-triage'],
  'mem':      ['cortex-gardening', 'overlay-triage', 'performance-regression'],
};

// Per-skill descriptions: what the skill does and what the user gets out of running it.
// Keyed by a fragment of the skill label (lowercased, hyphenated).
const SKILL_DESCRIPTIONS: Record<string, { what: string; benefit: string }> = {
  'docs-maintenance':       { what: 'audits your documentation for outdated content, broken references, and gaps',           benefit: 'keeps your docs accurate and trustworthy without a manual read-through' },
  'security-review':        { what: 'checks your codebase for vulnerabilities, outdated dependencies, and access-control gaps', benefit: 'catches security issues before they become incidents' },
  'cortex-gardening':       { what: 'finds duplicate nodes, resolves contradictions, and trims stale memories in your cortex', benefit: 'keeps your memory sharp and recall results clean' },
  'skill-maintenance':      { what: 'reviews all your trained skills for staleness, low vitality, and missing trigger coverage', benefit: 'makes sure your skills are reliable and up to date before you run them' },
  'consistency-audit':      { what: 'scans your codebase or cortex for naming inconsistencies, style drift, and broken conventions', benefit: 'surfaces divergence early, while it\'s still cheap to fix' },
  'ship-workflow':          { what: 'guides you through changelog review, version bump, release notes, and publishing', benefit: 'ships a clean, traceable release without missing steps' },
  'bug-investigation':      { what: 'walks through reproducing the bug, narrowing the cause, and proposing a fix', benefit: 'turns a vague error into a concrete, actionable diagnosis' },
  'ux-review':              { what: 'checks your UI changes for usability, accessibility, and visual consistency', benefit: 'catches UX regressions before users do' },
  'ux-decision':            { what: 'frames a UI design decision with options, tradeoffs, and a recommendation', benefit: 'makes opinionated design calls faster, with a clear rationale' },
  'performance-regression': { what: 'profiles the affected path, compares against baseline, and suggests where to look', benefit: 'pinpoints slowdowns before they land in production' },
  'changelog-management':   { what: 'collects commits since the last release and drafts a readable changelog', benefit: 'saves you writing the changelog by hand' },
  'content-creation':       { what: 'outlines, drafts, and refines a piece of content using your stored notes and voice', benefit: 'turns cortex notes into a polished draft' },
  'feature-impact':         { what: 'maps the new feature against existing memory, flags conflicts, and estimates blast radius', benefit: 'finds surprises before you write the first line of code' },
  'enterprise-gtm':         { what: 'builds a go-to-market plan for an enterprise tier: positioning, objections, sales motion', benefit: 'gives you a structured GTM brief you can hand to the team' },
};

function describeSkill(skillLabel: string): { what: string; benefit: string } {
  const key = Object.keys(SKILL_DESCRIPTIONS).find((k) => skillLabel.includes(k));
  return key
    ? SKILL_DESCRIPTIONS[key]!
    : { what: 'automates a multi-step task across your cortex', benefit: 'saves you time and keeps things consistent' };
}

const OBLIGATION_DUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OBLIGATION_TASK_SKILL_FRAGMENT = 'task-todo-management';

const TIME_BASED_RULES: Array<{
  skillLabelFragment: string;
  minElapsedMs: number;
  signalLabel: string;
}> = [
  {
    skillLabelFragment: 'security-review',
    minElapsedMs: 7 * 24 * 60 * 60 * 1000,
    signalLabel: 'More than 7 days since last security review',
  },
  {
    skillLabelFragment: 'cortex-gardening',
    minElapsedMs: 3 * 24 * 60 * 60 * 1000,
    signalLabel: 'More than 3 days since last cortex cleanup',
  },
  {
    skillLabelFragment: 'skill-maintenance-review',
    minElapsedMs: 7 * 24 * 60 * 60 * 1000,
    signalLabel: 'More than 7 days since last skill review',
  },
  {
    skillLabelFragment: 'consistency-audit',
    minElapsedMs: 5 * 24 * 60 * 60 * 1000,
    signalLabel: 'More than 5 days since last consistency audit',
  },
];

// ── Watcher class ─────────────────────────────────────────────────────────────

export class ProactiveWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private cards: ProactiveCard[] = [];
  private cardsThisSession = 0;
  // suppression key → last proposed timestamp
  private suppressed = new Map<string, number>();
  // last proposed timestamp for time-based rules, keyed by fragment
  private lastTimeBasedProposal = new Map<string, number>();
  // skillSourceId → snooze-until ms
  private snoozedUntil = new Map<string, number>();
  // skillSourceId → dismissed-at ms (longer suppression)
  private dismissedSkills = new Map<string, number>();
  private dispatchTriggerLines: string[] = [];
  private stateLoaded = false;
  private stateDirty = false;

  constructor(private deps: ProactiveWatcherDeps) {}

  start(): void {
    if (this.timer) return;
    void this.initState().then(() => {
      this.refreshDispatchTriggers();
      const delayMs = resolveGhampusProactiveSettings(this.deps.host.getSettings().agent).startupDelayMs;
      this.startupTimer = setTimeout(() => { void this.tick(); }, delayMs);
      this.startupTimer.unref?.();
      this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
      this.timer.unref?.();
    });
  }

  stop(): void {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    void this.flushState();
  }

  private async initState(): Promise<void> {
    const cortexDir = this.deps.host.getCortexDir?.();
    if (!cortexDir) return;
    const persisted = await loadWatcherState(cortexDir);
    for (const [k, v] of Object.entries(persisted.suppressed ?? {})) {
      if (typeof v === 'number') this.suppressed.set(k, v);
    }
    for (const [k, v] of Object.entries(persisted.lastTimeBasedProposal ?? {})) {
      if (typeof v === 'number') this.lastTimeBasedProposal.set(k, v);
    }
    for (const [k, v] of Object.entries(persisted.snoozedUntil ?? {})) {
      if (typeof v === 'number') this.snoozedUntil.set(k, v);
    }
    for (const [k, v] of Object.entries(persisted.dismissedSkills ?? {})) {
      if (typeof v === 'number') this.dismissedSkills.set(k, v);
    }
    this.stateLoaded = true;
  }

  private async flushState(): Promise<void> {
    if (!this.stateDirty || !this.stateLoaded) return;
    const cortexDir = this.deps.host.getCortexDir?.();
    if (!cortexDir) return;
    await saveWatcherState(cortexDir, {
      suppressed: Object.fromEntries(this.suppressed),
      lastTimeBasedProposal: Object.fromEntries(this.lastTimeBasedProposal),
      snoozedUntil: Object.fromEntries(this.snoozedUntil),
      dismissedSkills: Object.fromEntries(this.dismissedSkills),
    });
    this.stateDirty = false;
  }

  private markStateDirty(): void {
    this.stateDirty = true;
    void this.flushState();
  }

  /** Reload skill-dispatch trigger table (call after retrain). */
  refreshDispatchTriggers(): void {
    if (!this.deps.skillTrainer) {
      this.dispatchTriggerLines = [];
      return;
    }
    for (const gid of this.deps.host.listGraphs()) {
      const sourceId = findSkillDispatchSourceId(this.deps.host, gid);
      if (!sourceId) continue;
      const detail = this.deps.skillTrainer.getSkill(gid, sourceId);
      if (detail?.text) {
        this.dispatchTriggerLines = extractDispatchTriggerLines(detail.text);
        return;
      }
    }
    this.dispatchTriggerLines = [];
  }

  listCards(): ProactiveCard[] {
    return this.cards.filter((c) => c.status === 'pending' || c.status === 'running');
  }

  dismissCard(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    if (!card) return;
    card.status = 'dismissed';
    this.dismissedSkills.set(card.skillSourceId, Date.now());
    const key = `${card.signalType}:${card.skillSourceId}`;
    this.suppressed.set(key, Date.now());
    this.markStateDirty();
  }

  snoozeCard(id: string, snoozeMs = SUPPRESS_MS): void {
    const card = this.cards.find((c) => c.id === id);
    if (!card) return;
    card.status = 'snoozed';
    const until = Date.now() + snoozeMs;
    this.snoozedUntil.set(card.skillSourceId, until);
    const key = `${card.signalType}:${card.skillSourceId}`;
    this.suppressed.set(key, Date.now());
    this.markStateDirty();
  }

  markRunning(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    if (card) card.status = 'running';
  }

  markDone(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    if (card) card.status = 'done';
  }

  // ── Private tick ─────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.cardsThisSession >= MAX_CARDS_SESSION) return;
    if (!this.deps.skillTrainer) return;

    const { isBusyAbove, WorkPriority } = await import('./work-priority.js');
    if (isBusyAbove(WorkPriority.P2_GHAMPUS)) return;

    this.refreshDispatchTriggers();

    const skills = this.deps.skillTrainer.listSkills();
    if (skills.length === 0) return;

    // Filter out meta-skills and build a usable index.
    const usableSkills = skills.filter((s) => {
      const label = s.label.replace(/^skill:\d+:/, '');
      return !META_SKILLS.has(label);
    });

    const now = Date.now();
    const proposed: ProactiveCard[] = [];
    // Track which skill sourceIds are already proposed this tick so we never
    // emit the same skill twice in a single scan, regardless of how many
    // signals match it.
    const proposedSkillIds = new Set<string>();

    // ── Pass 0: temporal obligations due ≤7d or overdue ─────────────────────
    // Parallel to GoalTracker deadline alerts — obligations use structured
    // expiresAt metadata rather than text extraction from goal: sources.
    await this.proposeObligationCards(usableSkills, proposed, proposedSkillIds, now);

    // ── Pass 1: recent-ingest signals ──────────────────────────────────────────
    try {
      const { notifications: recent } = listNotifications(
        { host: this.deps.host },
        { sinceMs: now - 2 * 60 * 60 * 1000, limit: 20 }, // last 2 hours
      );

      for (const notif of recent) {
        if (this.cardsThisSession + proposed.length >= MAX_CARDS_SESSION) break;

        const signalContext = `${notif.label} ${notif.originKind} ${notif.origin} ${notif.engramId}`;
        const signalWords = tokenize(signalContext);

        const bestMatch = this.findBestSkillMatch(
          usableSkills, signalWords, signalContext, 'recent-ingest', notif.sourceId, proposedSkillIds,
        );
        if (bestMatch) {
          proposedSkillIds.add(bestMatch.sourceId);
          const skillLabel = bestMatch.label.replace(/^skill:\d+:/, '');
          const desc = describeSkill(skillLabel);
          const sourceHint = truncate(notif.label.replace(/^[^:]+:/, '').replace(/\//g, ' › '), 40);
          proposed.push({
            id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: now,
            signalType: 'recent-ingest',
            signalLabel: `You just added "${sourceHint}" to your ${notif.engramId} engram.`,
            skillSourceId: bestMatch.sourceId,
            skillGraphId: bestMatch.graphId,
            skillLabel,
            why: `**${skillLabel.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}** ${desc.what}. Running it now ${desc.benefit}.`,
            status: 'pending',
          });
        }
      }
    } catch { /* non-fatal */ }

    // ── Pass 2: time-based rules ───────────────────────────────────────────────
    for (const rule of TIME_BASED_RULES) {
      if (this.cardsThisSession + proposed.length >= MAX_CARDS_SESSION) break;

      const lastProposed = this.lastTimeBasedProposal.get(rule.skillLabelFragment) ?? 0;
      if (now - lastProposed < rule.minElapsedMs) continue;

      const skill = usableSkills.find((s) =>
        s.label.replace(/^skill:\d+:/, '').includes(rule.skillLabelFragment),
      );
      if (!skill) continue;

      const suppressKey = `time-based:${skill.sourceId}`;
      if (this.isSuppressed(suppressKey, now)) continue;

      // Don't propose if the same skill was already proposed this tick.
      if (proposedSkillIds.has(skill.sourceId)) continue;
      if (this.isSkillSnoozedOrDismissed(skill.sourceId, now)) continue;

      const skillLabel = skill.label.replace(/^skill:\d+:/, '');
      const desc = describeSkill(skillLabel);
      proposed.push({
        id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        signalType: 'time-based',
        signalLabel: rule.signalLabel,
        skillSourceId: skill.sourceId,
        skillGraphId: skill.graphId,
        skillLabel,
        why: `**${skillLabel.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}** ${desc.what}. Running it now ${desc.benefit}.`,
        status: 'pending',
      });
      this.lastTimeBasedProposal.set(rule.skillLabelFragment, now);
      this.markStateDirty();
    }

    // ── Emit new cards ────────────────────────────────────────────────────────
    for (const card of proposed) {
      const suppressKey = `${card.signalType}:${card.skillSourceId}`;
      this.suppressed.set(suppressKey, now);
      this.cards.push(card);
      this.cardsThisSession++;
      this.markStateDirty();

      try {
        this.deps.broadcastRaw({
          kind: 'ghampus.card',
          name: 'ghampus.card',
          payload: card,
        });
      } catch { /* non-fatal */ }
    }
  }

  private async proposeObligationCards(
    skills: Array<{ sourceId: string; graphId: string; label: string }>,
    proposed: ProactiveCard[],
    proposedSkillIds: Set<string>,
    now: number,
  ): Promise<void> {
    if (this.cardsThisSession + proposed.length >= MAX_CARDS_SESSION) return;

    const taskSkill = skills.find((s) =>
      s.label.replace(/^skill:\d+:/, '').includes(OBLIGATION_TASK_SKILL_FRAGMENT),
    );
    if (!taskSkill) return;

    const suppressKey = `obligation-due:${taskSkill.sourceId}`;
    if (this.isSuppressed(suppressKey, now)) return;
    if (this.isSkillSnoozedOrDismissed(taskSkill.sourceId, now)) return;
    if (proposedSkillIds.has(taskSkill.sourceId)) return;

    await this.deps.host.obligationIndex.ensureLoaded();
    const due = this.deps.host.obligationIndex.list({
      dueWithinMs: OBLIGATION_DUE_WINDOW_MS,
      includeOverdue: true,
      maxResults: 5,
      now,
    });
    if (due.length === 0) return;

    const overdue = due.filter((ob) => ob.expiresAt <= now).length;
    const upcoming = due.length - overdue;
    const skillLabel = taskSkill.label.replace(/^skill:\d+:/, '');
    proposed.push({
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      signalType: 'obligation-due',
      signalLabel: overdue > 0
        ? `${overdue} obligation(s) overdue, ${upcoming} due within 7 days`
        : `${upcoming} obligation(s) due within 7 days`,
      skillSourceId: taskSkill.sourceId,
      skillGraphId: taskSkill.graphId,
      skillLabel,
      why: `**Temporal obligations** — ${due.length} active deadline/renewal/review-by item(s) need attention. Run **task-todo-management** or call \`recall_obligations(due_within_days=7)\` for the full list.`,
      status: 'pending',
    });
    proposedSkillIds.add(taskSkill.sourceId);
    this.suppressed.set(suppressKey, now);
  }

  private findBestSkillMatch(
    skills: Array<{ sourceId: string; graphId: string; label: string }>,
    signalWords: string[],
    signalContext: string,
    signalType: string,
    signalId: string,
    proposedSkillIds: Set<string>,
  ): (typeof skills)[0] | null {
    const now = Date.now();
    let bestSkill: (typeof skills)[0] | null = null;
    let bestScore = 0;

    for (const skill of skills) {
      const skillLabel = skill.label.replace(/^skill:\d+:/, '');
      const suppressKey = `${signalType}:${skill.sourceId}:${signalId}`;

      if (proposedSkillIds.has(skill.sourceId)) continue;
      if (this.isSuppressed(suppressKey, now)) continue;
      if (this.isSkillSnoozedOrDismissed(skill.sourceId, now)) continue;
      if (this.cards.some((c) => c.skillSourceId === skill.sourceId && c.status === 'pending')) continue;

      const score = this.scoreMatch(skillLabel, signalWords, signalContext);
      if (score > bestScore && score >= 2) {
        bestScore = score;
        bestSkill = skill;
      }
    }

    if (bestSkill) {
      this.suppressed.set(`${signalType}:${bestSkill.sourceId}:${signalId}`, now);
    }

    return bestSkill;
  }

  private isSkillSnoozedOrDismissed(skillSourceId: string, now: number): boolean {
    const snoozeUntil = this.snoozedUntil.get(skillSourceId) ?? 0;
    if (snoozeUntil > now) return true;
    const dismissedAt = this.dismissedSkills.get(skillSourceId) ?? 0;
    return now - dismissedAt < SUPPRESS_MS;
  }

  private scoreMatch(skillLabel: string, signalWords: string[], signalContext: string): number {
    let score = 0;
    const skillWords = tokenize(skillLabel);

    // Pass 1: skill-dispatch trigger table (highest weight).
    if (this.dispatchTriggerLines.length > 0) {
      const dispatchMatches = matchDispatchTriggers(signalContext, this.dispatchTriggerLines);
      for (const dm of dispatchMatches) {
        if (skillLabel.includes(dm.skillSlug)) {
          score += dm.score + 4;
        }
      }
    }

    // Pass 2: direct word overlap + keyword map.
    for (const sw of signalWords) {
      if (skillWords.some((kw) => kw.startsWith(sw) || sw.startsWith(kw))) {
        score += 2;
      }
      const mapped = KEYWORD_SKILL_MAP[sw];
      if (mapped) {
        const mapList = Array.isArray(mapped) ? mapped : [mapped];
        for (const fragment of mapList) {
          if (skillLabel.includes(fragment)) {
            score += 3;
          }
        }
      }
    }

    return score;
  }

  private isSuppressed(key: string, now: number): boolean {
    const last = this.suppressed.get(key) ?? 0;
    return now - last < SUPPRESS_MS;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/.:,;()\[\]{}'"!?@#$%^&*+=<>\\|]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'that', 'with', 'this', 'from',
  'has', 'had', 'have', 'been', 'not', 'but', 'you', 'all', 'can',
  'her', 'his', 'its', 'one', 'our', 'out', 'use', 'any', 'may',
]);
