// Ghampus Proactive Watcher
//
// Runs on a timer (default 90s), scans for signals (recent ingestion, elapsed
// time since last quality check, etc.), and matches them against the skill
// library. High-confidence matches are surfaced as "proposed cards" that
// appear in the Ghampus chat thread — the user presses Run, Snooze, or
// Dismiss.
//
// Matching strategy: two-pass.
//   1. Keyword overlap between signal labels and skill name words.
//   2. Time-based rules for skills with no strong label signal (security
//      cadence, cortex gardening, skill maintenance review).
//
// Anti-spam: max 3 NEW cards per session; 6-hour suppression per
// {signalType, skillSourceId} pair; skill-dispatch + skill-maintenance-review
// are excluded from auto-proposal (they're meta-skills).
//
// All state is in-memory per sidecar session. Disk persistence of dismissed
// cards is deferred to the next iteration.

import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';
import type { BroadcastRawFn } from './events.js';
import { listNotifications } from './agent-notifications.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ProactiveCard {
  id: string;
  createdAt: number;
  /** What triggered this proposal. */
  signalType: 'recent-ingest' | 'time-based' | 'recall-pattern';
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
  'cortex-gardening':       { what: 'finds duplicate nodes, resolves contradictions, and trims stale memories in your cortex', benefit: 'keeps your memory sharp and recall results clean' },
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

// Time-based rules.
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
  private cards: ProactiveCard[] = [];
  private cardsThisSession = 0;
  // suppression key → last proposed timestamp
  private suppressed = new Map<string, number>();
  // last proposed timestamp for time-based rules, keyed by fragment
  private lastTimeBasedProposal = new Map<string, number>();

  constructor(private deps: ProactiveWatcherDeps) {}

  start(): void {
    if (this.timer) return;
    // Wait 5 minutes before first scan — gives the user time to orient and
    // avoids flooding the thread with cards the moment the app opens.
    setTimeout(() => { void this.tick(); }, 5 * 60_000);
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  listCards(): ProactiveCard[] {
    return this.cards.filter((c) => c.status === 'pending' || c.status === 'running');
  }

  dismissCard(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    if (card) card.status = 'dismissed';
  }

  snoozeCard(id: string): void {
    const card = this.cards.find((c) => c.id === id);
    if (card) {
      card.status = 'snoozed';
      // Re-propose after 6 hours by pushing the suppression window.
      const key = `${card.signalType}:${card.skillSourceId}`;
      this.suppressed.set(key, Date.now());
    }
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

    // ── Pass 1: recent-ingest signals ──────────────────────────────────────────
    try {
      const { notifications: recent } = listNotifications(
        { host: this.deps.host },
        { sinceMs: now - 2 * 60 * 60 * 1000, limit: 20 }, // last 2 hours
      );

      for (const notif of recent) {
        if (this.cardsThisSession + proposed.length >= MAX_CARDS_SESSION) break;

        // Build signal words from label + originKind + sourceId fragment.
        const signalWords = tokenize(
          `${notif.label} ${notif.originKind} ${notif.origin} ${notif.engramId}`,
        );

        const bestMatch = this.findBestSkillMatch(usableSkills, signalWords, 'recent-ingest', notif.sourceId, proposedSkillIds);
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
    }

    // ── Emit new cards ────────────────────────────────────────────────────────
    for (const card of proposed) {
      const suppressKey = `${card.signalType}:${card.skillSourceId}`;
      this.suppressed.set(suppressKey, now);
      this.cards.push(card);
      this.cardsThisSession++;

      try {
        this.deps.broadcastRaw({
          kind: 'ghampus.card',
          name: 'ghampus.card',
          payload: card,
        });
      } catch { /* non-fatal */ }
    }
  }

  private findBestSkillMatch(
    skills: Array<{ sourceId: string; graphId: string; label: string }>,
    signalWords: string[],
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

      // Skip if already proposed this tick, suppressed from a prior tick,
      // or already pending in the card inbox.
      if (proposedSkillIds.has(skill.sourceId)) continue;
      if (this.isSuppressed(suppressKey, now)) continue;
      if (this.cards.some((c) => c.skillSourceId === skill.sourceId && c.status === 'pending')) continue;

      const score = this.scoreMatch(skillLabel, signalWords);
      if (score > bestScore && score >= 2) {
        bestScore = score;
        bestSkill = skill;
        // Don't record suppression here — only record it after the card is
        // actually committed, in tick(). Recording here would suppress the
        // winning skill from being found by subsequent signal iterations.
      }
    }

    // Record per-signal suppression only for the winner, after scoring is done.
    if (bestSkill) {
      this.suppressed.set(`${signalType}:${bestSkill.sourceId}:${signalId}`, now);
    }

    return bestSkill;
  }

  private scoreMatch(skillLabel: string, signalWords: string[]): number {
    let score = 0;
    const skillWords = tokenize(skillLabel);

    // Direct word overlap between skill name and signal words.
    for (const sw of signalWords) {
      if (skillWords.some((kw) => kw.startsWith(sw) || sw.startsWith(kw))) {
        score += 2;
      }
      // Keyword map lookup.
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
