/**
 * GET /api/admin/audit
 *
 * List audit log entries for compliance review (SOC 2 / ISO 27001).
 * Supports ?email= and ?limit= filters.
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import type { AuditEntry } from '../../../server/groups.js';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const kv    = requireKv(env, 'BILLING_KV');
  const email = url.searchParams.get('email')?.toLowerCase().trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 500);

  // KV list with prefix "audit:" — results are in key order (lexicographic by ts).
  const listed = await kv.list({ prefix: 'audit:', limit: 1000 });
  const keys   = listed.keys.map(k => k.name).reverse(); // newest first

  const entries: AuditEntry[] = [];
  for (const key of keys) {
    if (entries.length >= limit) break;
    const raw = await kv.get(key);
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw) as AuditEntry;
      if (email && entry.email !== email) continue;
      entries.push(entry);
    } catch { /* skip malformed */ }
  }

  return new Response(JSON.stringify({ entries, count: entries.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
