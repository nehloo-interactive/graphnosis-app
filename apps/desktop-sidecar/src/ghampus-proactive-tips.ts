/**
 * Ghampus proactive tip cards — static library + scheduler.
 *
 * Surfaces contextual tips in Ghampus chat when the user is idle (settings toggle is the control).
 * Separate from todo reminders; in-app only (no native notifications).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveGhampusTipsSettings } from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import { isGhampusBusy, ghampusUserIdleMs } from './ghampus-busy.js';
import { shouldDeferGhampusBackground, scaleGhampusStartupDelay } from './background-lane-scheduler.js';

export type GhampusTipCategory =
  | 'job-memory'
  | 'slash-commands'
  | 'engram-scoping'
  | 'follow-ups'
  | 'skills'
  | 'mcp-claude'
  | 'romanian'
  | 'recovery'
  | 'brain-linking'
  | 'sharing';

export interface ProactiveTip {
  id: string;
  title: string;
  body: string;
  category: GhampusTipCategory;
  weight: number;
  examplePrompt?: string;
  expectedOutcome?: string;
}

export interface GhampusTipPayload {
  id: string;
  tipId: string;
  title: string;
  body: string;
  category: GhampusTipCategory;
  ts: number;
  examplePrompt?: string;
  expectedOutcome?: string;
  notify: false;
}

interface TipsState {
  version: 1;
  shownTipIds: Record<string, number>;
  lastStartupTipDay?: string;
}

export interface GhampusProactiveTipsSchedulerDeps {
  host: GraphnosisHost;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
}

const TICK_MS = 5 * 60_000;
const STATE_FILE = 'ghampus-tips-state.json';
const USER_IDLE_MS = 5 * 60_000;
const REPEAT_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_STARTUP_DELAY_MS = 3 * 60_000;

/** Static tip library — no cloud LLM required. */
export const PROACTIVE_TIPS: ProactiveTip[] = [
  {
    id: 'job-obligation-remember',
    title: 'Job memory with deadlines',
    body: 'When you **remember** work items, add obligation metadata (`deadline`, `review-by`) so Ghampus can trace them in time and surface due-date reminders.',
    category: 'job-memory',
    weight: 3,
    examplePrompt: 'Remember: finish Q2 budget review by Friday — obligation deadline 2026-06-27',
    expectedOutcome: 'Stored with parsed obligation; appears in startup/daily todo summaries when due.',
  },
  {
    id: 'job-recall-obligations',
    title: 'Trace obligations in time',
    body: 'Ask Ghampus or Claude to **recall obligations** due this week — the sidecar indexes deadline metadata across engrams (excluding sensitive tiers).',
    category: 'job-memory',
    weight: 2,
    examplePrompt: 'What obligations are due in the next 7 days?',
    expectedOutcome: 'List of obligation-backed memories sorted by due date with engram labels.',
  },
  {
    id: 'job-temporal-todos',
    title: 'Natural-language due dates',
    body: 'Todo lines with phrases like **due tomorrow**, **by Friday**, or **termen vineri** are parsed automatically — no special syntax beyond plain language.',
    category: 'job-memory',
    weight: 2,
    examplePrompt: 'Remember: send invoice to Acme — due next Tuesday',
    expectedOutcome: 'Heuristic todo scan picks up the line; due-soon cards appear before the date.',
  },
  {
    id: 'slash-save',
    title: '/save — quick capture',
    body: 'Type **`/save`** followed by a note to persist it through Ghampus without leaving the chat. Routes through the same remember pipeline as MCP.',
    category: 'slash-commands',
    weight: 2,
    examplePrompt: '/save Decision: ship v1.20 after smoke passes',
    expectedOutcome: 'Memory saved to the default engram; confirmation in thread.',
  },
  {
    id: 'slash-recall',
    title: '/recall — scoped search',
    body: '**`/recall`** runs a fast semantic search over your cortex and returns grounded snippets — useful before asking a follow-up question.',
    category: 'slash-commands',
    weight: 2,
    examplePrompt: '/recall Graphnosis release checklist',
    expectedOutcome: 'Top matching memories with previews; Ghampus can answer from them.',
  },
  {
    id: 'slash-skill',
    title: '/skill — train a workflow',
    body: '**`/skill`** or **train skill** starts skill authoring from the chat. Capture a repeatable procedure once; Ghampus walks it on demand.',
    category: 'slash-commands',
    weight: 2,
    examplePrompt: '/skill ship-workflow for our release batch',
    expectedOutcome: 'Skill draft captured; appears in Skills with walk/run actions.',
  },
  {
    id: 'engram-scope',
    title: 'Scope to an engram',
    body: 'Prefix queries with an engram name — e.g. **"in writings engram, recall draft posts"** — to search one graph instead of the whole cortex.',
    category: 'engram-scoping',
    weight: 2,
    examplePrompt: 'In coding engram, what did we decide about the sidecar IPC socket?',
    expectedOutcome: 'Recall limited to that engram; fewer irrelevant hits.',
  },
  {
    id: 'engram-sensitive',
    title: 'Sensitive vs personal tiers',
    body: '**Sensitive** engrams require consent before cloud AI reads them. Personal engrams are recall-only for proactive injection. Check tier badges in the engram picker.',
    category: 'engram-scoping',
    weight: 1,
    examplePrompt: 'Recall investor update draft',
    expectedOutcome: 'If sensitive: consent modal in app before data leaves the machine.',
  },
  {
    id: 'follow-up-name-them',
    title: 'Follow-up: "name them all"',
    body: 'After a list answer, say **"name them all"** or **"expand each"** — Ghampus keeps thread context and elaborates without re-searching from scratch.',
    category: 'follow-ups',
    weight: 2,
    examplePrompt: 'Name them all with one-line summaries',
    expectedOutcome: 'Structured expansion of the prior list using conversation history.',
  },
  {
    id: 'follow-up-pivot',
    title: 'Pivot topics cleanly',
    body: 'Start a new line with **"switching topic:"** or ask about something unrelated — Ghampus treats it as a fresh turn while history stays in the thread.',
    category: 'follow-ups',
    weight: 1,
    examplePrompt: 'Switching topic: what skills cover deployment?',
    expectedOutcome: 'New recall path; prior turn context not forced into the answer.',
  },
  {
    id: 'skills-walk',
    title: 'Walk a trained skill',
    body: 'Matched skills show as cards in chat. Click **Run** to walk step-by-step with cost preview — local Ollama when adaptive routing allows.',
    category: 'skills',
    weight: 2,
    examplePrompt: 'Run ship-workflow',
    expectedOutcome: 'Walk plan with steps, models, and est. cost; progress in thread.',
  },
  {
    id: 'skills-list',
    title: 'List available skills',
    body: 'Ask **"list skills"** or use the Skills tab. Ghampus lazy-loads skill titles first, full steps only when matched.',
    category: 'skills',
    weight: 1,
    examplePrompt: 'What skills do I have for bug investigation?',
    expectedOutcome: 'Skill index filtered by trigger/title; match cards for relevant SOPs.',
  },
  {
    id: 'mcp-claude-connect',
    title: 'Connect Claude Desktop',
    body: 'Add Graphnosis as an MCP server in Claude Desktop (Settings → Developer). Your cortex stays local; Claude calls **recall** / **remember** tools.',
    category: 'mcp-claude',
    weight: 2,
    examplePrompt: 'What do I know about the DRP proposal?',
    expectedOutcome: 'Claude invokes recall; answers grounded in your encrypted graph.',
  },
  {
    id: 'mcp-consent-tiers',
    title: 'Consent tiers for AI clients',
    body: 'Settings → AI → Consent Phrases gate **personal** and **sensitive** data. Type the phrase in chat when prompted — never guess it.',
    category: 'mcp-claude',
    weight: 1,
    examplePrompt: '(after sensitive recall) User types consent phrase from app',
    expectedOutcome: 'confirm_data_access unlocks tier for the session; recall retries.',
  },
  {
    id: 'ro-cauta',
    title: 'Romanian: caută / găsește',
    body: 'Întrebări în română funcționează nativ — **"caută termenul pentru contractul X"** sau **"găsește notițele despre proiectul Y"**.',
    category: 'romanian',
    weight: 2,
    examplePrompt: 'Caută ce am notat despre termenul de livrare Acme',
    expectedOutcome: 'Semantic search + răspuns în română din amintiri stocate.',
  },
  {
    id: 'ro-termen',
    title: 'Romanian: termen & scadențe',
    body: '**"termen"**, **"scadent"**, **"până vineri"** declanșează parsarea temporală — aceleași remindere ca pentru todo-uri în engleză.',
    category: 'romanian',
    weight: 2,
    examplePrompt: 'Amintește: trimite raportul — termen luni',
    expectedOutcome: 'Obligație/todo cu dată parsată; apare în sumarul zilnic.',
  },
  {
    id: 'recovery-memory-studio',
    title: 'Memory Studio recovery',
    body: 'If a save looks wrong, open **Memory Studio** → inspect the node → **edit** or **forget**. Audit log shows every AI write.',
    category: 'recovery',
    weight: 1,
    examplePrompt: 'Open Memory Studio and find nodes tagged ship-workflow',
    expectedOutcome: 'Inspector with full content, provenance, and edit/forget actions.',
  },
  {
    id: 'recovery-lkg-promote',
    title: 'Promote .lkg when save blocked',
    body: 'When shrink-save blocks a write, check **Recovery** for a `.lkg` (last-known-good) snapshot. Promote it to restore a safe on-disk state.',
    category: 'recovery',
    weight: 1,
    examplePrompt: '(after save blocked toast) Recovery panel → promote .lkg for engram',
    expectedOutcome: 'Restored bundle; brain mutations resume for that engram.',
  },
  {
    id: 'brain-auto-link',
    title: 'Auto-linked memories',
    body: 'The brain pass links related nodes across engrams. Explore links in the **3D graph** or ask **"what connects to X?"** for surfaced edges.',
    category: 'brain-linking',
    weight: 2,
    examplePrompt: 'What memories link to the GraphnosisApp release decision?',
    expectedOutcome: 'Linked nodes and edges from brain + semantic neighbors.',
  },
  {
    id: 'brain-3d-engram',
    title: '3D engram view',
    body: 'Open any engram in **3D** to see spatial clusters. Vitality color reflects recency — stale areas may need re-ingest or skill retrain.',
    category: 'brain-linking',
    weight: 1,
    examplePrompt: 'Show coding engram in 3D after a big ingest',
    expectedOutcome: 'Interactive graph; click nodes for inspector preview.',
  },
  {
    id: 'sharing-federation',
    title: 'Engram sharing basics',
    body: 'Share an engram with a collaborator via **Sharing** — editor vs viewer roles, encrypted sync. Federated unlock uses Enterprise SSO when enabled.',
    category: 'sharing',
    weight: 1,
    examplePrompt: 'Share graphnosis-skills engram with team@company.com as editor',
    expectedOutcome: 'Invite flow; collaborator sees shared engram after accept.',
  },
  {
    id: 'example-create-engram',
    title: 'Create a focused engram',
    body: 'Separate domains into engrams (coding, writings, legal) so recall stays precise. **Create engram** from the picker or `/create`.',
    category: 'engram-scoping',
    weight: 1,
    examplePrompt: '/create engram "client-acme" personal tier',
    expectedOutcome: 'New empty engram ready for scoped remember/recall.',
  },
];

function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadState(cortexDir: string): Promise<TipsState> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as TipsState;
    if (parsed.version !== 1) throw new Error('bad version');
    return {
      version: 1,
      shownTipIds: parsed.shownTipIds ?? {},
      ...(typeof parsed.lastStartupTipDay === 'string' ? { lastStartupTipDay: parsed.lastStartupTipDay } : {}),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT' && !(e instanceof SyntaxError)) {
      console.error(`[ghampus-tips] state load failed: ${err.message}`);
    }
    return { version: 1, shownTipIds: {} };
  }
}

async function saveState(cortexDir: string, state: TipsState): Promise<void> {
  const target = path.join(cortexDir, STATE_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

function pickWeightedTip(pool: ProactiveTip[]): ProactiveTip | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((s, t) => s + Math.max(1, t.weight), 0);
  let r = Math.random() * total;
  for (const tip of pool) {
    r -= Math.max(1, tip.weight);
    if (r <= 0) return tip;
  }
  return pool[pool.length - 1] ?? null;
}

export class GhampusProactiveTipsScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private state: TipsState = { version: 1, shownTipIds: {} };
  private stateLoaded = false;
  private tickInFlight = false;

  constructor(private deps: GhampusProactiveTipsSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.init().then(() => {
      const base = resolveGhampusTipsSettings(this.deps.host.getSettings().agent).startupDelayMs;
      const delay = scaleGhampusStartupDelay(this.deps.host, base);
      this.startupTimer = setTimeout(() => { void this.tick(true); }, delay);
      this.startupTimer.unref?.();
      this.timer = setInterval(() => { void this.tick(false); }, TICK_MS);
      this.timer.unref?.();
    });
  }

  stop(): void {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Test hook — run one scheduling pass. */
  async tickForTest(startup = false): Promise<{ emitted: boolean; tipId?: string }> {
    await this.init();
    return this.tick(startup);
  }

  private async init(): Promise<void> {
    if (this.stateLoaded) return;
    this.state = await loadState(this.deps.cortexDir);
    this.stateLoaded = true;
  }

  private isEnabled(): boolean {
    if (this.deps.host.getSettings().agent?.enabled === false) return false;
    return resolveGhampusTipsSettings(this.deps.host.getSettings().agent).enabled;
  }

  private cortexReady(): boolean {
    return this.deps.host.listGraphs().length > 0;
  }

  private eligibleTips(now: number): ProactiveTip[] {
    return PROACTIVE_TIPS.filter((tip) => {
      const last = this.state.shownTipIds[tip.id] ?? 0;
      return now - last >= REPEAT_COOLDOWN_MS;
    });
  }

  private canEmitNow(): boolean {
    if (!this.isEnabled()) return false;
    if (!this.cortexReady()) return false;
    if (isGhampusBusy()) return false;
    if (shouldDeferGhampusBackground(this.deps.host)) return false;
    if (ghampusUserIdleMs() < USER_IDLE_MS) return false;

    return true;
  }

  private async tick(startupPass: boolean): Promise<{ emitted: boolean; tipId?: string }> {
    if (this.tickInFlight) return { emitted: false };
    this.tickInFlight = true;
    try {
      await this.init();
      const now = Date.now();
      const day = localDayKey(new Date(now));

      if (!this.canEmitNow()) return { emitted: false };

      if (startupPass) {
        if (this.state.lastStartupTipDay === day) return { emitted: false };
      }

      const pool = this.eligibleTips(now);
      const tip = pickWeightedTip(pool);
      if (!tip) return { emitted: false };

      await this.emitTip(tip, now);

      this.state.shownTipIds[tip.id] = now;
      if (startupPass) this.state.lastStartupTipDay = day;

      await saveState(this.deps.cortexDir, this.state);
      return { emitted: true, tipId: tip.id };
    } catch (err) {
      console.error('[ghampus-tips] tick error:', err);
      return { emitted: false };
    } finally {
      this.tickInFlight = false;
    }
  }

  private async emitTip(tip: ProactiveTip, now: number): Promise<void> {
    const payload: GhampusTipPayload = {
      id: `tip-${tip.id}-${now}`,
      tipId: tip.id,
      title: tip.title,
      body: tip.body,
      category: tip.category,
      ts: now,
      notify: false,
      ...(tip.examplePrompt ? { examplePrompt: tip.examplePrompt } : {}),
      ...(tip.expectedOutcome ? { expectedOutcome: tip.expectedOutcome } : {}),
    };

    const histMsg = {
      kind: 'tip' as const,
      tipId: tip.id,
      title: tip.title,
      body: tip.body,
      category: tip.category,
      ts: now,
      ...(tip.examplePrompt ? { examplePrompt: tip.examplePrompt } : {}),
      ...(tip.expectedOutcome ? { expectedOutcome: tip.expectedOutcome } : {}),
    };

    const histPath = path.join(this.deps.cortexDir, 'ghampus-history.jsonl');
    await fs.appendFile(histPath, JSON.stringify(histMsg) + '\n').catch(() => {});
    const { appendGhampusHistoryCacheMessage } = await import('./ghampus-history-cache.js');
    appendGhampusHistoryCacheMessage(histMsg);

    try {
      this.deps.broadcastRaw({ kind: 'ghampus.tip', name: 'ghampus.tip', payload });
    } catch { /* non-fatal */ }
  }
}

export { DEFAULT_STARTUP_DELAY_MS };
