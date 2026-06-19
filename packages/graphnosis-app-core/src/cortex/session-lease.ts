/**
 * Session heartbeat lease — UX layer for "another device has this cortex open".
 * Authoritative writes still go through `.lockfile`; this file is user-friendly.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SESSION_LEASE_FILE = 'session.lease';

/** Default staleness window — lease older than this is ignored. */
export const SESSION_LEASE_STALE_MS = 90_000;

/** How often an active session should refresh the lease. */
export const SESSION_LEASE_REFRESH_MS = 30_000;

export interface SessionLease {
  deviceName: string;
  hostname: string;
  pid?: number;
  updatedAt: number;
}

export function sessionLeasePath(cortexDir: string): string {
  return path.join(cortexDir, SESSION_LEASE_FILE);
}

export function isSessionLeaseFresh(lease: SessionLease | null | undefined, now = Date.now()): boolean {
  if (!lease || typeof lease.updatedAt !== 'number') return false;
  return now - lease.updatedAt < SESSION_LEASE_STALE_MS;
}

export async function readSessionLease(cortexDir: string): Promise<SessionLease | null> {
  try {
    const raw = await fs.readFile(sessionLeasePath(cortexDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLease>;
    if (
      typeof parsed.deviceName !== 'string'
      || typeof parsed.hostname !== 'string'
      || typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return {
      deviceName: parsed.deviceName,
      hostname: parsed.hostname,
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      updatedAt: parsed.updatedAt,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

export async function writeSessionLease(cortexDir: string, lease: SessionLease): Promise<void> {
  const target = sessionLeasePath(cortexDir);
  const tmp = `${target}.${process.pid}.tmp`;
  const body = JSON.stringify(lease, null, 2);
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, target);
}

export async function clearSessionLease(cortexDir: string): Promise<void> {
  await fs.rm(sessionLeasePath(cortexDir), { force: true });
}

/** True when another session's lease is still fresh (not this pid). */
export async function isCortexSessionBusy(
  cortexDir: string,
  selfPid = process.pid,
): Promise<{ busy: boolean; lease: SessionLease | null }> {
  const lease = await readSessionLease(cortexDir);
  if (!lease || !isSessionLeaseFresh(lease)) {
    return { busy: false, lease };
  }
  if (lease.pid === selfPid) {
    return { busy: false, lease };
  }
  return { busy: true, lease };
}
