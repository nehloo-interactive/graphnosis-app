/**
 * IT classification schema — shared cache for Settings graph list.
 */
import { ipcCall } from './ipc';

export interface ClassificationLabelView {
  id: string;
  displayName: string;
  color: string;
  internalTier: 'public' | 'personal' | 'sensitive';
  userAssignable?: boolean;
  enabled?: boolean;
}

export interface ClassificationSchemaView {
  enabled: boolean;
  labels: ClassificationLabelView[];
  defaultEngramLabel?: string;
}

let cachedSchema: ClassificationSchemaView | null = null;
let schemaLoadedAt = 0;

export async function fetchClassificationSchema(force = false): Promise<ClassificationSchemaView | null> {
  if (!force && cachedSchema && Date.now() - schemaLoadedAt < 30_000) {
    return cachedSchema;
  }
  try {
    const res = await ipcCall<{ ok: boolean; schema?: ClassificationSchemaView }>(
      'compliance.getClassificationSchema',
      {},
    );
    if (!res.ok || !res.schema) {
      cachedSchema = null;
      return null;
    }
    cachedSchema = res.schema;
    schemaLoadedAt = Date.now();
    return cachedSchema;
  } catch {
    return null;
  }
}

export function invalidateClassificationSchemaCache(): void {
  cachedSchema = null;
  schemaLoadedAt = 0;
}

export function assignableLabels(schema: ClassificationSchemaView): ClassificationLabelView[] {
  return schema.labels.filter((l) => l.enabled !== false && l.userAssignable !== false);
}

export function labelColorStyle(color: string): string {
  if (color.startsWith('#') || color.startsWith('rgb')) return color;
  const tokens: Record<string, string> = {
    green: '#22c55e',
    yellow: '#eab308',
    red: '#ef4444',
  };
  return tokens[color.toLowerCase()] ?? 'var(--fg-dim)';
}
