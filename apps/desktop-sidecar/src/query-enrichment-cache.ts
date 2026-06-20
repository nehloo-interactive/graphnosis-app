/**
 * Session-scoped memo for deterministic query entity extraction.
 *
 * `extractQueryEntities()` runs regex/heuristic passes on every recall and
 * dig_deeper. Within one sidecar process the same query often repeats (MCP
 * retries, dig_deeper after recall, multi-tool agent loops). This cache
 * stores the extracted entity list keyed by a normalized query string.
 *
 * - LRU cap: 256 entries (oldest evicted on insert when full)
 * - TTL: 30 minutes per entry (also pruned on read)
 * - Cleared on cortex lock via `invalidateQueryEnrichmentCache()`; process
 *   exit clears naturally.
 *
 * Entity extraction is query-text-only (not engram-scoped). LLM query
 * enrichment (`enrichRecallQuery`) is separate and uncached here.
 */

import { extractQueryEntities } from './host/recall.js';

const MAX_ENTRIES = 256;
const TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  entities: string[];
  expiresAt: number;
}

const entityCache = new Map<string, CacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

/** Normalize query text for stable cache keys (trim, collapse whitespace, lowercase). */
export function normalizeQueryCacheKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of entityCache) {
    if (now > entry.expiresAt) entityCache.delete(key);
  }
}

function touchLru(key: string, entry: CacheEntry): void {
  entityCache.delete(key);
  entityCache.set(key, entry);
}

/** Return cached entities when present and fresh; otherwise undefined. */
export function getCachedQueryEntities(query: string): string[] | undefined {
  pruneExpired();
  const key = normalizeQueryCacheKey(query);
  const entry = entityCache.get(key);
  if (!entry) {
    cacheMisses += 1;
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    entityCache.delete(key);
    cacheMisses += 1;
    return undefined;
  }
  cacheHits += 1;
  touchLru(key, entry);
  return entry.entities;
}

export function setCachedQueryEntities(query: string, entities: string[]): void {
  pruneExpired();
  const key = normalizeQueryCacheKey(query);
  if (entityCache.size >= MAX_ENTRIES && !entityCache.has(key)) {
    const oldest = entityCache.keys().next().value;
    if (oldest !== undefined) entityCache.delete(oldest);
  }
  entityCache.set(key, {
    entities: [...entities],
    expiresAt: Date.now() + TTL_MS,
  });
}

/** Memoized wrapper around `extractQueryEntities`. */
export function cachedExtractQueryEntities(query: string): string[] {
  const hit = getCachedQueryEntities(query);
  if (hit) return hit;
  const entities = extractQueryEntities(query);
  setCachedQueryEntities(query, entities);
  return entities;
}

/** Drop all cached entity lists — call when the cortex is locked. */
export function invalidateQueryEnrichmentCache(): void {
  entityCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/** Test/diagnostic counters (hits, misses, live entry count). */
export function queryEnrichmentCacheStats(): { hits: number; misses: number; size: number } {
  pruneExpired();
  return { hits: cacheHits, misses: cacheMisses, size: entityCache.size };
}
