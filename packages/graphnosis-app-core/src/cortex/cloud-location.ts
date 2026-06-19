/**
 * Heuristic cloud-sync location detection for cortex folders.
 * Pure path-string analysis — no filesystem I/O.
 */

export type CortexCloudMode = 'local' | 'personal-cloud' | 'shared-cloud' | 'ambiguous-cloud';

export type CloudProviderId =
  | 'icloud'
  | 'dropbox'
  | 'google-drive'
  | 'onedrive'
  | 'box'
  | 'generic';

export interface CortexCloudInfo {
  mode: CortexCloudMode;
  provider: CloudProviderId;
  /** User-facing label, e.g. "iCloud", "Dropbox", "Cloud folder". */
  providerLabel: string;
  /** True when the path sits under a known cloud-sync root. */
  inCloudFolder: boolean;
}

const PROVIDER_LABELS: Record<CloudProviderId, string> = {
  'icloud': 'iCloud',
  'dropbox': 'Dropbox',
  'google-drive': 'Google Drive',
  'onedrive': 'OneDrive',
  'box': 'Box',
  'generic': 'Cloud folder',
};

interface ProviderRule {
  id: CloudProviderId;
  /** Path segment markers (lowercase, normalized slashes). */
  markers: string[];
}

const PROVIDER_RULES: ProviderRule[] = [
  {
    id: 'icloud',
    markers: [
      'mobile documents/com~apple~clouddocs',
      'mobile documents/com~apple~clouddocs/',
      'icloud drive',
      'library/mobile documents/com~apple~clouddocs',
    ],
  },
  {
    id: 'dropbox',
    markers: ['/dropbox/', '/dropbox', 'dropbox/'],
  },
  {
    id: 'google-drive',
    markers: [
      '/google drive/',
      '/google drive',
      '/googledrive/',
      '/googledrive',
      'my drive/',
    ],
  },
  {
    id: 'onedrive',
    markers: ['/onedrive/', '/onedrive', 'onedrive -', 'onedrive/'],
  },
  {
    id: 'box',
    markers: ['/box/', '/box sync/', '/box sync'],
  },
];

/** iCloud Shared / collaboration folder heuristics. */
const SHARED_MARKERS = [
  'mobile documents/com~apple~clouddocs/shared',
  '/shared/',
  '/shared ',
  'shared with me',
  'team folders',
  'collaboration',
  '.dropbox.cache',
];

function normalizePath(cortexPath: string): string {
  return cortexPath.replace(/\\/g, '/').toLowerCase().trim();
}

function detectProvider(normalized: string): CloudProviderId {
  for (const rule of PROVIDER_RULES) {
    for (const marker of rule.markers) {
      if (normalized.includes(marker)) return rule.id;
    }
  }
  // Loose fallbacks for paths that mention a provider name without standard roots.
  if (normalized.includes('icloud')) return 'icloud';
  if (normalized.includes('dropbox')) return 'dropbox';
  if (normalized.includes('google drive') || normalized.includes('googledrive')) return 'google-drive';
  if (normalized.includes('onedrive')) return 'onedrive';
  if (normalized.includes('/box/') || normalized.endsWith('/box')) return 'box';
  return 'generic';
}

function isInCloudRoot(normalized: string): boolean {
  if (detectProvider(normalized) !== 'generic') return true;
  // Generic "cloud folder" parent names users sometimes pick.
  return (
    normalized.includes('/cloud/')
    || normalized.includes('/sync/')
    || normalized.includes('/cloud storage/')
  );
}

function looksShared(normalized: string, provider: CloudProviderId): boolean {
  for (const marker of SHARED_MARKERS) {
    if (normalized.includes(marker)) return true;
  }
  // iCloud Shared is reliably under .../Shared/...
  if (provider === 'icloud' && /mobile documents\/com~apple~clouddocs\/shared/.test(normalized)) {
    return true;
  }
  // Dropbox shared-folder naming: "Team folder" style paths.
  if (provider === 'dropbox' && (normalized.includes('(team)') || normalized.includes('/team folder'))) {
    return true;
  }
  return false;
}

/**
 * Detect how a cortex folder relates to cloud sync.
 *
 * @param userSharedConfirm When set, resolves `ambiguous-cloud` to personal or shared.
 */
export function detectCortexCloudMode(
  cortexPath: string,
  userSharedConfirm?: boolean | null,
): CortexCloudMode {
  const info = analyzeCortexCloudLocation(cortexPath);
  if (!info.inCloudFolder) return 'local';
  if (info.mode === 'shared-cloud' || info.mode === 'personal-cloud') return info.mode;
  // ambiguous-cloud
  if (userSharedConfirm === true) return 'shared-cloud';
  if (userSharedConfirm === false) return 'personal-cloud';
  return 'ambiguous-cloud';
}

/** Full analysis including provider label. */
export function analyzeCortexCloudLocation(cortexPath: string): CortexCloudInfo {
  const normalized = normalizePath(cortexPath);
  const inCloudFolder = isInCloudRoot(normalized);
  if (!inCloudFolder) {
    return {
      mode: 'local',
      provider: 'generic',
      providerLabel: PROVIDER_LABELS.generic,
      inCloudFolder: false,
    };
  }

  const provider = detectProvider(normalized);
  const providerLabel = PROVIDER_LABELS[provider];

  if (looksShared(normalized, provider)) {
    return { mode: 'shared-cloud', provider, providerLabel, inCloudFolder: true };
  }

  // Personal cloud sync (same account, multiple devices) — default for known roots
  // that don't match shared heuristics.
  if (provider !== 'generic') {
    return { mode: 'personal-cloud', provider, providerLabel, inCloudFolder: true };
  }

  return { mode: 'ambiguous-cloud', provider, providerLabel, inCloudFolder: true };
}

/** @deprecated Use {@link analyzeCortexCloudLocation}. Kept for sidecar startup-error compat. */
export function isSyncedCortexPath(cortexPath: string): boolean {
  return analyzeCortexCloudLocation(cortexPath).inCloudFolder;
}

export function cloudProviderLabel(cortexPath: string): string {
  return analyzeCortexCloudLocation(cortexPath).providerLabel;
}
