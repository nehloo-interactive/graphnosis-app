/**
 * Lazy dependency injection for UI domain modules.
 * main.ts calls `bindAppContext()` once after shared helpers exist,
 * then each module's `init*()` reads what it needs.
 */
import type { GraphWithMetadata, NodeRecord, OpLogEvent, StatusSnapshot } from './types';

/** Minimal element refs shared across modules — populated from main.ts `els`. */
export interface UiElements {
  [key: string]: HTMLElement;
}

export interface AppContext {
  els: UiElements;
  getLoadedGraphs: () => GraphWithMetadata[];
  engramName: (graphId: string) => string;
  friendlyClient: (name?: string) => string;
  showError: (msg: string | null) => void;
  render: (status: StatusSnapshot) => void;
  getUnlockPending: () => boolean;
  rememberCortexDir: (dir: string | null | undefined) => void;
  addIngestToast: (label: string, message?: string) => string;
  finishIngestToast: (id: string, kind: 'success' | 'error', message?: string) => void;
  renderRailGetConnected: () => void;
  updateAtlasSyncButton: () => void;
  activateMode: (mode: string) => void;
  renderMarkdownLite: (md: string) => string;
  getGraphnosisGlobalNodes: () => Map<string, NodeRecord[]>;
  getGraphnosisAllNodes: () => NodeRecord[];
  getAtlasActiveGraph: () => string | null;
  getSourcesFilterTerm: () => string;
  setSourcesFilterTerm: (v: string) => void;
  showQuarantineConfirm: (opts: QuarantineConfirmOptions) => void;
  showRecoveryPhraseModal: (phrase: string) => void;
  refreshStats: () => Promise<void>;
  openCortexManagementModal: () => void;
  getNnConfirmPending: () => boolean;
  setNnConfirmPending: (v: boolean) => void;
  getNnEnablingInProgress: () => boolean;
  setNnEnablingInProgress: (v: boolean) => void;
  getLlmConfirmPending: () => boolean;
  setLlmConfirmPending: (v: boolean) => void;
  LAST_ENGRAM_KEY: string;
  /** Re-probe Touch ID availability for the lock screen (Tauri only). */
  refreshBiometricButton: (cortexDir: string) => void;
  /** Re-probe remote-server Touch ID availability (token stored + hardware). */
  refreshRemoteBiometricButton: (serverUrl: string) => void;
  syncEngramPicker: () => void;
  reloadGraphsMetadata: () => Promise<void>;
  pushDataIntoAtlas: () => void;
  renderAtlasLegend: () => void;
  mountAtlasIfNeeded: () => Promise<void>;
  currentAtlasEngineKind: () => import('../atlas-engine').AtlasEngineKind;
  getMainAtlas: () => { dispose: () => void; reapplyPerfFlags?: () => void } | null;
  getAtlasActiveGraph: () => string | null;
  getCurrentForgetMode: () => import('./types').ForgetMode;
  setCurrentForgetMode: (m: import('./types').ForgetMode) => void;
  ATLAS_ENGINE_STORAGE_KEY: string;
  isEngramPreloadInProgress: () => boolean;

  confirmPermanent: (bodyText: string) => Promise<boolean>;
  ipcLicenseStatus: () => Promise<{ valid?: boolean; features?: string[]; [key: string]: unknown }>;
  formatEngramLabel: (g: GraphWithMetadata) => string;
  slugifyEngramName: (name: string) => string;
  switchStudioTool: (tool: string, save?: boolean) => void;
  BILLING_BASE_URL: string;
  BILLING_EMAIL_KEY: string;
  replaceLoadedGraphs: (graphs: GraphWithMetadata[]) => void;
  pickAtlasGraph: () => string | null;
  setAtlasActiveGraph: (id: string | null) => void;
  refreshActiveEngramLabel: () => void;
  refreshAtlasView: () => Promise<void>;
  presActive: () => boolean;
  applyPresentationMasking: (root?: ParentNode) => void;
  clearAtlasGraphData: () => void;
  switchActiveEngram: (graphId: string) => Promise<void>;
  getIngestJobCount: () => number;
  renderStatusProcess: () => void;
}

export interface QuarantineConfirmOptions {
  title: string;
  subtitle: string;
  warningHtml: string;
  confirmPhrase: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

let ctx: AppContext | null = null;

export function bindAppContext(c: AppContext): void {
  ctx = c;
}

export function app(): AppContext {
  if (!ctx) throw new Error('AppContext not bound — call bindAppContext() from main.ts first');
  return ctx;
}

/** Shorthand for element lookup via bound context. */
export function el<T extends HTMLElement = HTMLElement>(key: string): T {
  return app().els[key] as T;
}

/**
 * Human label for an engram, falling back to its id.
 *
 * Rehomed here when the standalone Agents page was retired (2026-08-05). It had
 * been living in ui/agents.ts purely because that page happened to need it
 * first, and main.ts imported it across a module boundary that no longer exists.
 * It depends on nothing but the bound context, so this is its natural home.
 *
 * One deliberate behavior change: the agents.ts version had a second fallback
 * through that page's own in-memory skills list, which surfaced a name for an
 * engram that was not yet loaded. That state died with the page; an unloaded
 * engram now shows its id, which is what every other caller already did.
 */
export function engramDisplayName(graphId: string): string {
  const g = app().getLoadedGraphs().find((x) => x.graphId === graphId);
  return g ? app().formatEngramLabel(g) : graphId;
}

export type { OpLogEvent, GraphWithMetadata, NodeRecord, StatusSnapshot };
