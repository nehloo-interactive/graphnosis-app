/**
 * Recall-recipe → cited-node resolution for skill staleness tracking.
 *
 * Under the empty-engram train contract, personal memory is bound at walk/runtime
 * via recall recipes — not at compile time. This module executes those recipe
 * queries against live cortex and persists the returned node IDs into
 * AppSettings.skillCitedNodes so host.ts edit/forget hooks can enqueue retrains.
 */
import type { GraphnosisHost } from './host.js';

export interface ParsedRecallRecipeStep {
  tool: string;
  query: string;
  onlyEngrams?: string[];
  ifResultsBelow?: number;
}

export interface ParsedRecallRecipe {
  name: string;
  trigger: string;
  steps: ParsedRecallRecipeStep[];
}

const RECIPE_STEP_RE =
  /^[-—]\s*(recall|remind|dig_deeper|recall_structured|recall_with_citations|cross_search)\s*:\s*(.+)$/i;

/** True when a body paragraph looks like a recall recipe (name: trigger + steps). */
export function isRecallRecipeParagraph(text: string): boolean {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines[0]!.includes(':')) return false;
  return RECIPE_STEP_RE.test(lines[1]!.trim());
}

/**
 * Pull every engram name a free-form text blob references via a recall recipe —
 * `only_engrams: ["a", "b"]`, the `=` form (`only_engrams=[...]`), and the
 * `target_engram: "x"` single-engram form. Independent of full recipe structure
 * so it also catches an `only_engrams` clause sitting in a step's body or its
 * anchored supporting-context text, not just a well-formed recipe block.
 *
 * Used by the privacy hard-lock (Invariant 2): the walker resolves these names
 * to engram tiers at plan time so a step that recalls from a `sensitive` engram
 * is forced to a local model. Conservative by design — over-matching a name just
 * means an extra (harmless) tier lookup; a miss would silently leak.
 */
export function extractRecipeEngramNames(text: string): string[] {
  if (!text) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const name = raw.trim().replace(/^["']|["']$/g, '').trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  // only_engrams: [...] and only_engrams = [...]  (colon or equals, any spacing)
  for (const m of text.matchAll(/only_engrams\s*[:=]\s*\[([^\]]*)\]/gi)) {
    for (const part of (m[1] ?? '').split(',')) push(part);
  }
  // target_engram: "x" / target_engram = x  (single-engram recall scope)
  for (const m of text.matchAll(/target_engram\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,)\]]+)/gi)) {
    push(m[1] ?? '');
  }
  return names;
}

/** Parse plain-text recipe nodes (import + train paths). */
export function parseRecallRecipeText(text: string): ParsedRecallRecipe | null {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0]!;
  const colon = header.indexOf(':');
  if (colon <= 0) return null;
  const name = header.slice(0, colon).trim();
  const trigger = header.slice(colon + 1).trim();
  if (!name || !trigger) return null;

  const steps: ParsedRecallRecipeStep[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const m = line.match(RECIPE_STEP_RE);
    if (!m) continue;
    let rest = m[2]!.trim();
    let onlyEngrams: string[] | undefined;
    const engramMatch = rest.match(/\s+only_engrams:\s*\[([^\]]*)\]\s*$/i);
    if (engramMatch) {
      onlyEngrams = engramMatch[1]!
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      rest = rest.slice(0, engramMatch.index).trim();
    }
    let ifResultsBelow: number | undefined;
    const thresholdMatch = rest.match(/\s*\(if\s*<\s*(\d+)\s+results\)\s*$/i);
    if (thresholdMatch) {
      ifResultsBelow = Number(thresholdMatch[1]);
      rest = rest.slice(0, thresholdMatch.index).trim();
    }
    const query = rest.replace(/^["']|["']$/g, '').trim();
    if (!query) continue;
    steps.push({
      tool: m[1]!.toLowerCase(),
      query,
      ...(onlyEngrams?.length ? { onlyEngrams } : {}),
      ...(ifResultsBelow !== undefined ? { ifResultsBelow } : {}),
    });
  }
  if (steps.length === 0) return null;
  return { name, trigger, steps };
}

/** Collect recipe texts from a trained skill source (role=recipe or heuristic). */
export function extractRecallRecipesFromSource(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): ParsedRecallRecipe[] {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return [];

  const now = Date.now();
  const wantedIds = new Set(src.nodeIds);
  const recipes: ParsedRecallRecipe[] = [];

  for (const id of src.nodeIds) {
    const meta = host.listNodes(graphId).find((n) => n.id === id);
    if (!meta || !wantedIds.has(id)) continue;
    if (meta.confidence <= 0.2) continue;
    if (meta.validUntil !== undefined && meta.validUntil <= now) continue;
    const content = host.getFullNodeContent(graphId, id) ?? meta.contentPreview ?? '';
    if (!content.trim() || content.trimStart().startsWith('<!--')) continue;

    const section = (meta as { section?: string }).section;
    if (section === 'recipe' || isRecallRecipeParagraph(content)) {
      const parsed = parseRecallRecipeText(content);
      if (parsed) recipes.push(parsed);
    }
  }
  return recipes;
}

/** Resolve graph IDs from recipe onlyEngrams (template names or raw graphIds). */
export function resolveEngramScope(host: GraphnosisHost, onlyEngrams?: string[]): string[] | undefined {
  if (!onlyEngrams?.length) return undefined;
  const ids: string[] = [];
  for (const name of onlyEngrams) {
    if (host.listGraphs().includes(name)) {
      ids.push(name);
      continue;
    }
    for (const gid of host.listGraphs()) {
      const meta = host.getGraphMetadata(gid);
      if (meta?.displayName?.toLowerCase() === name.toLowerCase()) {
        ids.push(gid);
        break;
      }
    }
  }
  return ids.length > 0 ? ids : onlyEngrams;
}

/** Execute recall/remind steps and return cited node IDs with their engrams. */
export async function resolveRecallRecipeCitedNodes(
  host: GraphnosisHost,
  skillGraphId: string,
  sourceId: string,
): Promise<Array<{ nodeId: string; graphId: string }>> {
  const recipes = extractRecallRecipesFromSource(host, skillGraphId, sourceId);
  if (recipes.length === 0) return [];

  const seen = new Set<string>();
  const cited: Array<{ nodeId: string; graphId: string }> = [];
  const add = (nodeId: string, graphId: string): void => {
    const key = `${graphId}:${nodeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    cited.push({ nodeId, graphId });
  };

  for (const recipe of recipes) {
    let priorNodeCount = 0;
    for (const step of recipe.steps) {
      if (step.ifResultsBelow !== undefined && priorNodeCount >= step.ifResultsBelow) {
        continue;
      }
      const recallTools = new Set([
        'recall', 'remind', 'dig_deeper', 'recall_structured',
        'recall_with_citations', 'cross_search',
      ]);
      if (!recallTools.has(step.tool)) continue;

      const onlyGraphIds = resolveEngramScope(host, step.onlyEngrams);
      try {
        const sub = step.tool === 'dig_deeper'
          ? await host.digDeeper(step.query, {
              budget: { maxTokens: 1200, maxNodes: 20 },
              ...(onlyGraphIds ? { onlyGraphIds } : {}),
            })
          : await host.recall(step.query, {
              budget: { maxTokens: 1200, maxNodes: 20 },
              ...(onlyGraphIds ? { onlyGraphIds } : {}),
            });
        priorNodeCount = sub.nodesIncluded;
        for (const [gid, items] of sub.byGraph.entries()) {
          for (const item of items) add(item.nodeId, gid);
        }
      } catch {
        // Non-fatal — recipe binding is best-effort at bind time.
      }
    }
  }
  return cited;
}

/**
 * Resolve recall-recipe bindings and persist into skillCitedNodes.
 * Returns the node IDs that were persisted (may be empty when no recipes).
 */
export async function syncSkillCitedNodesFromRecipes(
  host: GraphnosisHost,
  skillGraphId: string,
  sourceId: string,
): Promise<string[]> {
  const cited = await resolveRecallRecipeCitedNodes(host, skillGraphId, sourceId);
  if (cited.length === 0) return [];

  // Group by engram — persistSkillCitedNodes expects one graphId per call;
  // cited nodes may span multiple personal engrams.
  const byGraph = new Map<string, string[]>();
  for (const { nodeId, graphId } of cited) {
    const arr = byGraph.get(graphId) ?? [];
    arr.push(nodeId);
    byGraph.set(graphId, arr);
  }

  const settings = host.getSettings();
  const prior = settings.skillCitedNodes?.[sourceId]?.nodes ?? {};
  const merged: Record<string, string> = { ...prior };
  for (const [gid, nodeIds] of byGraph) {
    for (const nid of nodeIds) merged[nid] = gid;
  }

  await host.setSettings({
    skillCitedNodes: {
      ...(settings.skillCitedNodes ?? {}),
      [sourceId]: { graphId: skillGraphId, nodes: merged },
    },
  });

  return Object.keys(merged);
}

/** Persist cited nodes on first walk when train-time binding was empty. */
export async function ensureSkillCitedNodesPersisted(
  host: GraphnosisHost,
  skillGraphId: string,
  sourceId: string,
): Promise<void> {
  const existing = host.getSettings().skillCitedNodes?.[sourceId];
  if (existing && Object.keys(existing.nodes).length > 0) return;
  await syncSkillCitedNodesFromRecipes(host, skillGraphId, sourceId);
}
