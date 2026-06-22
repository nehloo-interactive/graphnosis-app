/**
 * Graphnosis domain glossary for Ghampus LLM prompts — prevents wrong acronym hallucinations.
 */

import { stripInternalRecallWireFormat } from './ghampus-recall-format.js';

/** Shared glossary block for classify, synthesis, polish, and verify prompts. */
export const GHAMPUS_DOMAIN_GLOSSARY_BLOCK = `
GRAPHNOSIS DOMAIN GLOSSARY — use these terms exactly; never invent acronym expansions:
- MCP = Model Context Protocol (tool-server protocol for recall, remember, dig_deeper, etc.). NEVER "Master Certified Professional" or any other expansion.
- Ghampus = Graphnosis's built-in local agent (this assistant).
- Engram = an encrypted knowledge-graph partition (a named memory collection).
- Cortex = the user's full encrypted Graphnosis memory store on their device.
- Recall = semantic search over saved memories (MCP tool recall).
- dig_deeper = MCP tool to expand a recall hit with linked context.
- Sidecar = the local Graphnosis background process that hosts MCP and Ghampus.
- Attested memory = a fact saved explicitly by the user (not inferred/GNN overlay).

Do NOT expand acronyms unless the expansion appears verbatim in recall/cortex data. Use Graphnosis terms as-is.`;

/** Known wrong acronym expansions local LLMs invent — case-insensitive patterns. */
export const HALLUCINATED_ACRONYM_PATTERNS: RegExp[] = [
  /Master Certified Professional/i,
  /Management Certification Program/i,
  /Microsoft Certified Professional/i,
];

/** True when text contains a known wrong MCP (or related) acronym expansion. */
export function isHallucinatedAcronym(text: string): boolean {
  return HALLUCINATED_ACRONYM_PATTERNS.some((re) => re.test(text));
}

const MCP_WRONG_EXPANSION_RE = /\bMCP\s*\(\s*Master Certified Professional\s*\)/gi;
const WRONG_MCP_PHRASE_RE = /Master Certified Professional/gi;

/** Internal LLM prompt wrappers that must never appear in user-facing output. */
const LEAKED_PROMPT_TAG_RES: RegExp[] = [
  /<recent_chat>[\s\S]*?<\/recent_chat>/gi,
  /<cortex_data>[\s\S]*?<\/cortex_data>/gi,
  /<\/?recent_chat>/gi,
  /<\/?cortex_data>/gi,
  /<\/?conversation_transcript>/gi,
];

/**
 * Post-pass fix for obvious wrong MCP expansions before UI display.
 * Deterministic safety net when polish/verify still slip.
 */
export function sanitizeGhampusResponse(text: string): string {
  let out = text;
  for (const re of LEAKED_PROMPT_TAG_RES) {
    out = out.replace(re, '');
  }
  out = out.replace(MCP_WRONG_EXPANSION_RE, 'MCP (Model Context Protocol)');
  out = out.replace(WRONG_MCP_PHRASE_RE, 'Model Context Protocol');
  out = stripInternalRecallWireFormat(out);
  return out;
}
