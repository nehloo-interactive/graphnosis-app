/**
 * Live capability + skew record the host sidecar advertises to thin clients.
 *
 * Guest UIs (laptop remote mode) call `cortex:capabilities` after unlock so
 * they can route features (e.g. chat pins) without trial-and-error "Unknown
 * IPC method" probes. This is intentionally NOT an engram — it is process
 * truth about the running sidecar, not durable memory.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

/** Stable ids — add new ones when a guest needs to branch on host support. */
export type SidecarCapabilityId =
  | 'ghampus.chats.pin'
  | 'ghampus.chats.list'
  | 'mcp.tools.listChanged'
  | 'skill.role';

export interface SidecarCapabilitiesReport {
  schemaVersion: 1;
  /** Sidecar package version (apps/desktop-sidecar). */
  appVersion: string;
  /** GRAPHNOSIS_APP_VERSION from the shell when present (packaged app). */
  shellVersion: string | null;
  sdkVersion: string | null;
  secureSyncVersion: string | null;
  capabilities: SidecarCapabilityId[];
  reportedAt: number;
}

function readPkgVersion(pkgName: string): string | null {
  try {
    const pkg = require(`${pkgName}/package.json`) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readOwnAppVersion(): string {
  try {
    const raw = readFileSync(join(HERE, '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch { /* fall through */ }
  return process.env.GRAPHNOSIS_APP_VERSION?.trim() || '0.0.0';
}

/** Capability set for THIS build. Keep in sync with real IPC / MCP surfaces. */
export function listSidecarCapabilities(): SidecarCapabilityId[] {
  return [
    'ghampus.chats.list',
    'ghampus.chats.pin',
    'mcp.tools.listChanged',
    'skill.role',
  ];
}

export function getSidecarCapabilitiesReport(): SidecarCapabilitiesReport {
  return {
    schemaVersion: 1,
    appVersion: readOwnAppVersion(),
    shellVersion: process.env.GRAPHNOSIS_APP_VERSION?.trim() || null,
    sdkVersion: readPkgVersion('@nehloo/graphnosis'),
    secureSyncVersion: readPkgVersion('@nehloo-interactive/graphnosis-secure-sync'),
    capabilities: listSidecarCapabilities(),
    reportedAt: Date.now(),
  };
}

export function hostHasCapability(
  report: SidecarCapabilitiesReport | null | undefined,
  id: SidecarCapabilityId,
): boolean {
  return !!report?.capabilities.includes(id);
}
