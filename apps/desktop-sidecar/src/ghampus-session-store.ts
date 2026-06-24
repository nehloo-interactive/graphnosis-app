/**
 * Ghampus chat sessions — one JSONL file per session under cortex/ghampus/sessions/.
 * The active session id lives in cortex/ghampus/active-session.txt.
 *
 * Chat threads are UI/ephemeral context; durable facts belong in memory (remember).
 * Old sessions stay on disk as an audit trail when the user starts fresh.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEGACY_FLAT_HISTORY = 'ghampus-history.jsonl';

function ghampusRoot(cortexDir: string): string {
  return join(cortexDir, 'ghampus');
}

function sessionsDir(cortexDir: string): string {
  return join(ghampusRoot(cortexDir), 'sessions');
}

function activeSessionFile(cortexDir: string): string {
  return join(ghampusRoot(cortexDir), 'active-session.txt');
}

function sessionFile(cortexDir: string, sessionId: string): string {
  return join(sessionsDir(cortexDir), `${sessionId}.jsonl`);
}

export function newGhampusSessionId(): string {
  return `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/** Ensure layout exists and return the active session id (migrates legacy flat file once). */
export async function ensureActiveGhampusSession(cortexDir: string): Promise<string> {
  if (!cortexDir) return '';
  await mkdir(sessionsDir(cortexDir), { recursive: true });

  const activePath = activeSessionFile(cortexDir);
  let activeId = (await readFile(activePath, 'utf8').catch(() => '')).trim();
  if (activeId) return activeId;

  const legacyPath = join(cortexDir, LEGACY_FLAT_HISTORY);
  const legacyRaw = await readFile(legacyPath, 'utf8').catch(() => '');
  if (legacyRaw.trim()) {
    activeId = `imported-${Date.now()}`;
    await writeFile(sessionFile(cortexDir, activeId), legacyRaw, 'utf8');
    await rename(legacyPath, `${legacyPath}.migrated`).catch(() => {});
  } else {
    activeId = newGhampusSessionId();
    await writeFile(sessionFile(cortexDir, activeId), '', 'utf8');
  }
  await writeFile(activePath, activeId, 'utf8');
  return activeId;
}

export async function getActiveGhampusSessionPath(cortexDir: string): Promise<string> {
  const id = await ensureActiveGhampusSession(cortexDir);
  return id ? sessionFile(cortexDir, id) : '';
}

export async function readGhampusSessionRaw(cortexDir: string): Promise<string> {
  const path = await getActiveGhampusSessionPath(cortexDir);
  if (!path) return '';
  return readFile(path, 'utf8').catch(() => '');
}

export async function appendGhampusSessionMessage(cortexDir: string, msg: unknown): Promise<void> {
  const path = await getActiveGhampusSessionPath(cortexDir);
  if (!path) return;
  await appendFile(path, `${JSON.stringify(msg)}\n`, 'utf8');
}

/** Archive the current thread and start an empty session file. Previous file stays in sessions/. */
export async function clearGhampusSession(cortexDir: string): Promise<{
  previousSessionId: string;
  newSessionId: string;
}> {
  const previousSessionId = await ensureActiveGhampusSession(cortexDir);
  const newSessionId = newGhampusSessionId();
  await writeFile(activeSessionFile(cortexDir), newSessionId, 'utf8');
  await writeFile(sessionFile(cortexDir, newSessionId), '', 'utf8');
  return { previousSessionId, newSessionId };
}
