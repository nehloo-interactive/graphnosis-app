/**
 * Rate-limit repeated identical sidecar log lines — first occurrence at full
 * level, suppress repeats within an interval, emit a count summary when the
 * window elapses. Genuinely new keys always log immediately.
 */
import { dbg } from './log-redact.js';

const DEFAULT_INTERVAL_MS = 60_000;

type LogLevel = 'error' | 'warn';

interface ThrottleEntry {
  summaryMsg: string;
  firstAt: number;
  suppressed: number;
  timer: NodeJS.Timeout | null;
  level: LogLevel;
}

const throttleEntries = new Map<string, ThrottleEntry>();

function emit(level: LogLevel, message: string, ...rest: unknown[]): void {
  if (level === 'error') console.error(message, ...rest);
  else console.warn(message, ...rest);
}

const SIDECAR_TAG = '[graphnosis-sidecar]';

/** Strip leading sidecar tag so summary lines don't duplicate it. */
function withoutSidecarTag(message: string): string {
  return message.startsWith(SIDECAR_TAG)
    ? message.slice(SIDECAR_TAG.length).trimStart()
    : message;
}

function flushThrottle(key: string): void {
  const entry = throttleEntries.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.suppressed > 0) {
    const secs = Math.round((Date.now() - entry.firstAt) / 1000);
    emit(
      entry.level,
      `${SIDECAR_TAG} (repeated ${entry.suppressed}x in ${secs}s) ${withoutSidecarTag(entry.summaryMsg)}`,
    );
  }
  throttleEntries.delete(key);
}

function scheduleFlush(key: string, intervalMs: number): void {
  const entry = throttleEntries.get(key);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => flushThrottle(key), intervalMs);
  entry.timer.unref?.();
}

/**
 * Log `message` at `level`, throttled per `key`. Repeats within `intervalMs`
 * are suppressed; when the window ends a single summary line is emitted.
 * Optional `detail` (e.g. Error stack) is included only on the first log.
 */
export function logThrottled(
  key: string,
  message: string,
  options?: {
    intervalMs?: number;
    level?: LogLevel;
    detail?: unknown;
    /** After first log, repeats go to dbg() instead of being fully suppressed. */
    repeatAsDebug?: boolean;
  },
): void {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const level = options?.level ?? 'error';
  const repeatAsDebug = options?.repeatAsDebug ?? false;
  let entry = throttleEntries.get(key);

  if (!entry) {
    entry = { summaryMsg: message, firstAt: Date.now(), suppressed: 0, timer: null, level };
    throttleEntries.set(key, entry);
    emit(level, message, ...(options?.detail !== undefined ? [options.detail] : []));
    scheduleFlush(key, intervalMs);
    return;
  }

  entry.summaryMsg = message;
  if (repeatAsDebug) dbg(message);
  else entry.suppressed++;
}

/** First line of an error message, deduped when wrappers repeat it on one line. */
function dedupeRepeatedSuffix(s: string): string {
  const t = s.trim();
  for (let len = Math.floor(t.length / 2); len >= 12; len--) {
    const head = t.slice(0, len).trimEnd();
    const tail = t.slice(len).trimStart();
    if (head === tail) return head;
  }
  return t;
}

export function ipcErrorSummary(err: Error): string {
  const firstLine = (err.message ?? String(err)).split('\n')[0]?.trim() ?? 'unknown';
  return dedupeRepeatedSuffix(firstLine);
}

/** Normalize an error for IPC throttle keys — code + first line, no stack. */
export function ipcErrorKey(method: string, err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  return `${method}-${code ?? ipcErrorSummary(err)}`;
}

const OPLOG_ENOMEM_BACKOFF_MS = 60_000;
const OPLOG_ENOMEM_PAUSE_SEC = OPLOG_ENOMEM_BACKOFF_MS / 1000;
let oplogEnomemUntil = 0;

interface OplogEnomemWindow {
  methods: Set<string>;
  /** Silent repeats after the one first-line log in this window. */
  repeats: number;
  timer: NodeJS.Timeout | null;
}

let oplogEnomemWindow: OplogEnomemWindow | null = null;

function flushOplogEnomemWindow(): void {
  const w = oplogEnomemWindow;
  if (!w) return;
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  // One first log + one silent repeat → no summary (repeats === 1).
  if (w.repeats >= 2) {
    const methods = [...w.methods].sort().join(', ');
    console.warn(
      `${SIDECAR_TAG} oplog ENOMEM (${w.repeats + 1}x in ${OPLOG_ENOMEM_PAUSE_SEC}s) — ${methods}`,
    );
  }
  oplogEnomemWindow = null;
}

/** Set after activity.* oplog reads hit ENOMEM — callers can defer retries. */
export function recordOplogEnomem(): void {
  oplogEnomemUntil = Date.now() + OPLOG_ENOMEM_BACKOFF_MS;
}

export function isOplogEnomemBackoff(): boolean {
  return Date.now() < oplogEnomemUntil;
}

const OPLOG_RESOURCE_RE = /ENOMEM|not enough memory/i;

/** Walk err.cause chain — wrappers often drop .code but keep message/stack. */
export function errorChain(err: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  if (chain.length === 0 && err != null) {
    chain.push(err instanceof Error ? err : new Error(String(err)));
  }
  return chain;
}

/** True when an oplog disk read failed from memory pressure (Node, Bun, or wrapped). */
export function isOplogResourceError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    const sys = e as NodeJS.ErrnoException;
    if (sys.code === 'ENOMEM' || sys.errno === -12) return true;
    if (OPLOG_RESOURCE_RE.test(e.message ?? '')) return true;
    if (e.stack && OPLOG_RESOURCE_RE.test(e.stack)) return true;
    if (OPLOG_RESOURCE_RE.test(String(e))) return true;
  }
  return false;
}

function isActivityIpcMethod(method: string): boolean {
  return method.startsWith('activity.');
}

function isActivityOplogResourceError(method: string, err: Error): boolean {
  return isActivityIpcMethod(method) && isOplogResourceError(err);
}

/**
 * One shared warn per 60s for any activity oplog ENOMEM — methods tracked
 * silently; summary only when 3+ hits land in the same window.
 */
export function logActivityOplogResourceError(method: string, _err: Error): void {
  recordOplogEnomem();

  if (!oplogEnomemWindow) {
    oplogEnomemWindow = { methods: new Set([method]), repeats: 0, timer: null };
    console.warn(
      `${SIDECAR_TAG} oplog read failed (ENOMEM) on large cortex — activity queries paused ${OPLOG_ENOMEM_PAUSE_SEC}s`,
    );
    oplogEnomemWindow.timer = setTimeout(flushOplogEnomemWindow, OPLOG_ENOMEM_BACKOFF_MS);
    oplogEnomemWindow.timer.unref?.();
    return;
  }

  oplogEnomemWindow.methods.add(method);
  oplogEnomemWindow.repeats++;
}

/** IPC dispatch failures — full detail on first hit, aggregated summary on repeats. */
export function logIpcMethodError(method: string, err: Error): void {
  const summary = ipcErrorSummary(err);

  if (isActivityOplogResourceError(method, err)) {
    logActivityOplogResourceError(method, err);
    return;
  }

  const key = `ipc-${ipcErrorKey(method, err)}`;
  const stack = err.stack;
  logThrottled(
    key,
    `[graphnosis-sidecar] IPC method '${method}' failed: ${summary}`,
    {
      level: 'error',
      detail: stack && !stack.startsWith(summary) ? stack : undefined,
    },
  );
}

// ── Recall enrichment circuit breaker ───────────────────────────────────────

const ENRICHMENT_FAILURE_THRESHOLD = 3;
const ENRICHMENT_COOLDOWN_MS = 60_000;

let enrichmentFailureCount = 0;
let enrichmentCooldownUntil = 0;

/** True when enrichment should be skipped (open circuit) — no log per skip. */
export function isEnrichmentCircuitOpen(): boolean {
  return Date.now() < enrichmentCooldownUntil;
}

export function recordEnrichmentSuccess(): void {
  enrichmentFailureCount = 0;
  enrichmentCooldownUntil = 0;
}

export function recordEnrichmentFailure(expectedOffline: boolean): void {
  if (!expectedOffline) return;
  enrichmentFailureCount++;
  if (enrichmentFailureCount >= ENRICHMENT_FAILURE_THRESHOLD) {
    enrichmentCooldownUntil = Date.now() + ENRICHMENT_COOLDOWN_MS;
    logThrottled(
      'enrichment-circuit-open',
      `[host] recall enrichment offline — skipping enrichment for ${ENRICHMENT_COOLDOWN_MS / 1000}s after ${enrichmentFailureCount} failures`,
      { level: 'warn' },
    );
  }
}

/** Expected when Ollama is down or the machine is offline. */
export function isExpectedEnrichmentOffline(msg: string): boolean {
  return /unable to connect|computer able to access|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|network error|fetch failed|connection refused|ollama/i.test(msg);
}

/** Log enrichment failure — warn once, then debug for offline; throttle other errors. */
export function logEnrichmentFailure(msg: string): void {
  const offline = isExpectedEnrichmentOffline(msg);
  if (offline) {
    recordEnrichmentFailure(true);
    logThrottled(
      'enrichment-offline',
      `[host] recall enrichment failed, using raw query: ${msg}`,
      { level: 'warn', repeatAsDebug: true },
    );
  } else {
    logThrottled(
      `enrichment-failed-${msg.split('\n')[0]?.trim() ?? msg}`,
      `[host] recall enrichment failed, using raw query: ${msg}`,
      { level: 'error' },
    );
  }
}

/** Test helper — reset state between smoketest phases. */
export function resetLogRateLimitForTest(): void {
  for (const key of throttleEntries.keys()) flushThrottle(key);
  if (oplogEnomemWindow?.timer) clearTimeout(oplogEnomemWindow.timer);
  oplogEnomemWindow = null;
  enrichmentFailureCount = 0;
  enrichmentCooldownUntil = 0;
  oplogEnomemUntil = 0;
}
