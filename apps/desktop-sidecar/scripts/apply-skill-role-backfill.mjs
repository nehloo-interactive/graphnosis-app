#!/usr/bin/env node
/**
 * Apply sandbox/skill-role-backfill.json via the running Graphnosis MCP
 * after the app has been restarted onto a build that includes set_skill_roles.
 *
 * Usage (from repo root, with Graphnosis open):
 *   This script is a payload printer — the agent applies via MCP set_skill_roles.
 *   Or paste the JSON into an MCP call:
 *     set_skill_roles({ items: [...] })
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const path = resolve(root, 'sandbox/skill-role-backfill.json');
const items = JSON.parse(readFileSync(path, 'utf8')).map(({ engram, sourceId, role }) => ({
  engram,
  sourceId,
  role,
}));
console.log(JSON.stringify({ items, count: items.length }, null, 2));
