/**
 * Enterprise RBAC — role matrix for sharing tokens and future org-cortex seats.
 *
 * Maps coarse roles to MCP tool capabilities. Enforcement lives in
 * apps/desktop-sidecar/src/mcp-server.ts (tools/list + tools/call).
 *
 * Phase D (org cortex + SAML/OIDC) will attach the same roles to IdP groups;
 * see apps/docs/src/content/docs/guides/enterprise-rbac.md.
 */

/** Legacy + enterprise sharing roles. `owner` is reserved for full cortex access (not minted as a share). */
export type SharingRole =
  | 'viewer'          // legacy alias → recall-only
  | 'recall-only'
  | 'remember'
  | 'edit-approve'
  | 'editor'
  | 'skill-train'
  | 'admin-audit'
  | 'owner';

/** Fine-grained capability flags — a role grants a subset of these. */
export type McpToolCapability =
  | 'recall'
  | 'remember'
  | 'edit-propose'
  | 'edit-apply'
  | 'forget'
  | 'ingest'
  | 'transfer'
  | 'foresight'
  | 'audit'
  | 'skill-read'
  | 'skill-walk'
  | 'skill-write'
  | 'skill-export'
  | 'engram-pack';

/** All roles that may be assigned when creating a sharing token. */
export const SHARING_TOKEN_ROLES: readonly SharingRole[] = [
  'viewer',
  'recall-only',
  'remember',
  'edit-approve',
  'editor',
  'skill-train',
  'admin-audit',
] as const;

const ALL_CAPABILITIES: readonly McpToolCapability[] = [
  'recall',
  'remember',
  'edit-propose',
  'edit-apply',
  'forget',
  'ingest',
  'transfer',
  'foresight',
  'audit',
  'skill-read',
  'skill-walk',
  'skill-write',
  'skill-export',
  'engram-pack',
] as const;

/** Capability required to invoke each MCP tool (`correct` is an alias handled at dispatch). */
export const MCP_TOOL_CAPABILITIES: Readonly<Record<string, McpToolCapability[]>> = {
  recall: ['recall'],
  remind: ['recall'],
  dig_deeper: ['recall'],
  stats: ['recall'],
  list_engrams: ['recall'],
  list_attachments: ['recall'],
  suggest_engram: ['recall'],
  browse_engram: ['recall'],
  recent: ['recall'],
  get_engram_schema: ['recall'],
  recall_structured: ['recall'],
  recall_with_citations: ['recall'],
  recall_as_of: ['recall', 'audit'],
  compare_engrams: ['recall'],
  cross_search: ['recall'],
  find_source: ['recall'],
  recall_source: ['recall'],
  engram_summary: ['recall'],
  confirm_data_access: ['recall'],
  gnn_status: ['recall'],
  gnn_neighbors: ['recall'],
  remember: ['remember'],
  edit: ['edit-propose'],
  correct: ['edit-propose'],
  apply: ['edit-apply'],
  forget: ['forget'],
  ingest_batch: ['ingest'],
  transfer_source: ['transfer'],
  develop: ['foresight'],
  predict: ['foresight'],
  insights: ['foresight'],
  vitality: ['foresight'],
  llm_query: ['foresight'],
  llm_distill: ['foresight'],
  audit_memory: ['audit', 'foresight'],
  check_duplicate: ['audit'],
  duplicate_pairs: ['audit'],
  contradiction_pairs: ['audit'],
  healing_journal: ['audit'],
  list_skills: ['skill-read'],
  get_skill: ['skill-read'],
  skill_vitality: ['skill-read'],
  skill_history: ['skill-read'],
  walk_skill: ['skill-walk'],
  walk_skill_structured: ['skill-walk'],
  save_skill_run: ['skill-walk'],
  resume_skill_run: ['skill-walk'],
  train_skill: ['skill-write'],
  rollback_skill: ['skill-write'],
  delete_skill: ['skill-write'],
  export_skill: ['skill-export'],
  export_engram: ['engram-pack'],
  import_engram: ['engram-pack'],
};

const ROLE_CAPABILITY_MATRIX: Readonly<Record<SharingRole, readonly McpToolCapability[]>> = {
  'recall-only': ['recall', 'skill-read'],
  viewer: ['recall', 'skill-read'],
  remember: ['recall', 'skill-read', 'remember'],
  'edit-approve': ['recall', 'skill-read', 'remember', 'edit-propose'],
  editor: [
    'recall', 'skill-read', 'remember', 'edit-propose', 'edit-apply', 'forget',
    'ingest', 'transfer', 'foresight', 'skill-walk',
  ],
  'skill-train': [
    'recall', 'skill-read', 'remember', 'edit-propose', 'edit-apply', 'forget',
    'ingest', 'transfer', 'foresight', 'skill-walk', 'skill-write', 'skill-export',
  ],
  'admin-audit': ['recall', 'skill-read', 'audit', 'foresight'],
  owner: ALL_CAPABILITIES,
};

/** Human-readable labels for Settings / admin provision UIs. */
export const SHARING_ROLE_LABELS: Readonly<Record<SharingRole, string>> = {
  viewer: 'Viewer (legacy — recall only)',
  'recall-only': 'Recall only',
  remember: 'Remember',
  'edit-approve': 'Edit (approve in app)',
  editor: 'Editor',
  'skill-train': 'Skill trainer',
  'admin-audit': 'Admin / audit',
  owner: 'Owner',
};

export function isSharingRole(value: string): value is SharingRole {
  return (SHARING_TOKEN_ROLES as readonly string[]).includes(value) || value === 'owner';
}

/** Normalize legacy `viewer` to `recall-only` for matrix lookups. */
export function normalizeSharingRole(role: SharingRole): SharingRole {
  return role === 'viewer' ? 'recall-only' : role;
}

export function roleCapabilities(role: SharingRole): ReadonlySet<McpToolCapability> {
  const normalized = normalizeSharingRole(role);
  return new Set(ROLE_CAPABILITY_MATRIX[normalized] ?? ROLE_CAPABILITY_MATRIX['recall-only']);
}

export function toolRequiredCapabilities(toolName: string): readonly McpToolCapability[] {
  return MCP_TOOL_CAPABILITIES[toolName] ?? [];
}

/**
 * Returns true when every capability required by `toolName` is granted to `role`.
 * Unknown tools default to denied for scoped (sharing) sessions.
 */
export function isMcpToolAllowedForRole(toolName: string, role: SharingRole): boolean {
  if (normalizeSharingRole(role) === 'owner') return true;
  const required = toolRequiredCapabilities(toolName);
  if (required.length === 0) return false;
  const allowed = roleCapabilities(role);
  return required.every((cap) => allowed.has(cap));
}

/** Sorted tool names a role may invoke (for tools/list filtering and tests). */
export function mcpToolsForRole(role: SharingRole): string[] {
  if (normalizeSharingRole(role) === 'owner') {
    return Object.keys(MCP_TOOL_CAPABILITIES).sort();
  }
  const allowed = roleCapabilities(role);
  return Object.keys(MCP_TOOL_CAPABILITIES)
    .filter((tool) => {
      const req = toolRequiredCapabilities(tool);
      return req.length > 0 && req.every((cap) => allowed.has(cap));
    })
    .sort();
}

export function sharingRoleViolationMessage(toolName: string, role: SharingRole): string {
  const label = SHARING_ROLE_LABELS[normalizeSharingRole(role)] ?? role;
  return (
    `⛔ Tool "${toolName}" is not allowed for share role "${label}". ` +
    'Contact the cortex owner to request a broader role or a new share.'
  );
}
