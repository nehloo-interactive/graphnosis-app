/** Ghampus recall prompt / structured-node helpers — keep audit meta out of user answers. */
// @ts-nocheck — recovered from compiled bundle 2026-06-21; tighten types on next edit.
import {
  extractPersonInContextFromQuery,
  extractQuotedPhrases,
  isRecallQueryStopWord,
  textMatchesPhrase,
} from './ghampus-intent.js';
import { isHowToQuestionText } from './ghampus-language.js';

export { textMatchesPhrase };

export type StructuredRecallNode = {
  text?: string;
  engram?: string;
  graphId?: string;
  sourceId?: string;
  score?: number;
};

export type SkillListEntry = {
  label: string;
  trainedAt?: string;
  vitality?: number;
  searchText?: string;
};

export type McpToolListEntry = {
  name: string;
  shortDescription: string;
};


const PERSON_NAME_RE = /\b[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)?\b/;
const PERSON_NAME_G = new RegExp(PERSON_NAME_RE.source, 'g');

function titleCaseLatinToken(s: string): string {
  return s.replace(/(?:^|\s)([a-zăâîșț])/g, (m, c: string) => m.replace(c, c.toUpperCase()));
}


const ENGLISH_FORMATTER_STRINGS = {
  rosterEmpty: "I couldn't extract member names. Save an owner/member list or rephrase.",
  rosterHeader: (t) => `Members of **${t}**:`,
  teamHeader: (t) => `## Team **${t}**`,
  boardNote: "\n\n_Note: all Advisory Council members are also Board members._",
  tasksHeader: (l) => `## Tasks for **${l}**`,
  projectFallback: "project",
  teamTasksHeader: "## Team tasks by person",
  skillEmpty: (kw) => kw ? `No trained skills match \u201C${kw}\u201D. Try \`/skills\` to see everything.` : "No trained skills found. Train one in the Skills page.",
  skillHeader: (kw, n) => kw ? `**Skills matching \u201C${kw}\u201D (${n}):**` : `**Your skills (${n}):**`,
  mcpToolEmpty: (kw) => kw ? `No MCP tools match \u201C${kw}\u201D. Open **MCP Tools** in the sidebar for the full catalog.` : "No MCP tools are currently enabled. Check **Settings \u2192 MCP Tools**.",
  mcpToolHeader: (kw, n) => kw ? `**MCP tools matching \u201C${kw}\u201D (${n}):**` : `**MCP tools (${n}):**`,
  mcpToolFooter: "_These are sidecar MCP tools (recall, remember, list_skills, etc.) \u2014 not trained cortex skills. Use `/skills` for procedural skills._"
};
/** Parse node count from MCP recall prose (pipe IDs, audit footer, or bullets). */
export function parseRecallNodesIncluded(rawText: string): number {
  const attached = rawText.match(/Attached (\d+) memory node\(s\)/i);
  if (attached?.[1]) return parseInt(attached[1], 10);
  const pipeCount = (rawText.match(/\[[\w-]+\|/g) ?? []).length;
  if (pipeCount > 0) return pipeCount;
  if (/^ℹ️\s*No memories matched/im.test(rawText)) return 0;
  const bullets = rawText.match(/^-\s+.+/gm) ?? [];
  if (bullets.length > 0) return bullets.length;
  return 0;
}
export function formatterStrings(_query: string) {
  return ENGLISH_FORMATTER_STRINGS;
}
export function isConsentGateMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^⚠️\s*GRAPHNOSIS CONSENT (?:NEEDED|REQUIRED)/i.test(t)
    || (/^⚠️/.test(t) && /\bconsent\b/i.test(t) && /\b(?:approve|authori[sz]e|Allow \/ Deny)\b/i.test(t));
}

export function isRecallAuditMeta(text: string) {
  const t = text.trim();
  if (!t) return true;
  if (isConsentGateMessage(t)) return true;
  if (t === "---") return true;
  if (/^enriched:\s/i.test(t)) return true;
  if (/^_(?:enriched|anchored|GNN expanded)/i.test(t)) return true;
  if (/^💡\s/.test(t)) return true;
  if (/^Attached \d+ memory node\(s\)/.test(t)) return true;
  if (/^Per-graph \(tier · nodes · tokens\):/.test(t)) return true;
  if (/^\(\d+ other engram(?:s)? searched, no matches\.\)$/.test(t)) return true;
  if (/^Scope warnings:/.test(t)) return true;
  if (/^⚠️/.test(t) && /Heads-up|not loaded yet|engram(?:s)? exist/i.test(t)) return true;
  if (/^\[.+(?:access:|Revoke in Settings)/i.test(t)) return true;
  if (/^ℹ️\s*No memories matched/i.test(t)) return true;
  if (/before telling the user "nothing found"/i.test(t)) return true;
  if (/^🔁\s*BEFORE telling the user/i.test(t)) return true;
  return false;
}
export function stripMcpAuditFooterBlock(raw) {
  const sep = "\n\n---\n";
  let cut = raw;
  let idx = cut.lastIndexOf(sep);
  while (idx !== -1) {
    const tail = cut.slice(idx + sep.length).trim();
    if (/^Attached \d+ memory node\(s\)/.test(tail)) {
      cut = cut.slice(0, idx).trim();
      idx = cut.lastIndexOf(sep);
      continue;
    }
    break;
  }
  return cut;
}
export function stripMcpAuditInline(raw) {
  return raw.replace(/^---\s*$/gm, "").replace(/^Attached \d+ memory node\(s\)[^\n]*$/gm, "").replace(/^Per-graph \(tier · nodes · tokens\):[^\n]*$/gm, "").replace(/^\(\d+ other engram(?:s)? searched, no matches\.\)$/gm, "").replace(/^Scope warnings:[^\n]*$/gm, "").replace(/^⚠️[^\n]*(?:Heads-up|not loaded yet)[^\n]*$/gm, "").replace(/^\[[^\]]+(?:access:|Revoke in Settings)[^\]]*\]$/gim, "");
}
/** Section headers LLMs echo from recall / dig_deeper wire format — never user-facing. */
const INTERNAL_RECALL_SECTION_HEADERS: RegExp[] = [
  /^#{1,3}\s+Attested Memory\b/i,
  /^#{1,3}\s+dig_deeper\b/i,
  /^#{1,3}\s+Recall hits\b/i,
  /^#{1,3}\s+What I found in your cortex\b/i,
  /^#{1,3}\s+Recent Chat\b/i,
  /^#{1,3}\s+Recent chat history\b/i,
  /^#{1,3}\s+Additional context\b/i,
];

/** Inline recall-tool meta lines echoed into answers. */
const INTERNAL_RECALL_WIRE_LINE_RES: RegExp[] = [
  /Source-filename expansion/i,
  /Cross-engram entity hop/i,
  /via dig_deeper \(multi-strategy\)/i,
  /\bavg\.?\s*score\b/i,
  /\b(?:average|mean)\s+score\b/i,
  /\b\d+\s+memory node\(s\)\b/i,
  /^CALL `dig_deeper`/im,
  /^BEFORE telling the user/i,
  /^🔁\s*BEFORE telling/i,
  /^💡\s+Try dig_deeper/i,
  /^ℹ️\s*No memories matched/i,
];

function isInternalRecallSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  return INTERNAL_RECALL_SECTION_HEADERS.some((re) => re.test(trimmed));
}

/** Strip internal recall / dig_deeper wire sections and meta lines from LLM output. */
export function stripInternalRecallWireFormat(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,3}\s+/.test(trimmed) && isInternalRecallSectionHeader(trimmed)) {
      continue;
    }
    if (INTERNAL_RECALL_WIRE_LINE_RES.some((re) => re.test(line))) continue;
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function stripRecallAuditTrail(raw: string) {
  return stripInternalRecallWireFormat(
    stripSubgraphPresentation(
      stripMcpAuditInline(
        stripMcpAuditFooterBlock(raw).replace(/^_?enriched:\s*"[^"]*"\s*→\s*"[^"]*"_?\s*$/gim, "").replace(/^_anchored \d+ node\(s\) on entities:.*_$/gim, "").replace(/^_GNN expanded recall by \d+ node\(s\).*?_$/gim, "").replace(/^💡 _[\s\S]*?_\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trim()
      )
    ),
  );
}
export function stripSubgraphPresentation(raw: string) {
  return raw.replace(/^# Graphnosis context\s*$/gim, "").replace(/^The following memories from the user's personal knowledge graphs may be relevant\.\s*$/gim, "").replace(/^The following memories.*?may be relevant\.\s*$/gim, "").replace(/^=== KNOWLEDGE SUBGRAPH.*$/gm, "").replace(
    /^--- (?:NODES|DIRECTED|UNDIRECTED|SESSION SUMMARIES|CROSS-GRAPH CONNECTIONS|INFERRED LAYER[^-]*) ---\s*$/gm,
    ""
  ).replace(/^(?:n\w+ -\[|n\w+ ~\[).*$/gm, "").replace(/^\[[A-Za-z0-9_-]+\|[^|\]]+\|[^|\]]+(?:\|[^\]]*)?\]\s*/gm, "").replace(/^_+\(.*from cortex recall\)_+\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
}
export function looksLikeSubgraphDump(text: string) {
  if (!text.trim()) return false;
  return /=== KNOWLEDGE SUBGRAPH/i.test(text) || /^--- NODES ---/m.test(text) || /^--- DIRECTED ---/m.test(text) || /^--- UNDIRECTED ---/m.test(text) || /^--- SESSION SUMMARIES ---/m.test(text) || /# Graphnosis context/i.test(text) || /\[[A-Za-z0-9_-]+\|[^|\]]+\|[\d.]+/m.test(text) || /\|fact\|/i.test(text);
}
export function formatProseRecallForGhampusUser(raw: string, maxChars = 3000) {
  const stripped = stripRecallAuditTrail(raw);
  if (!stripped || looksLikeSubgraphDump(stripped)) return "";
  const bullets = [];
  let currentEngram = "";
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isRecallAuditMeta(trimmed)) continue;
    const engramHeader = trimmed.match(/^##\s+(.+)$/);
    if (engramHeader?.[1]) {
      currentEngram = engramHeader[1].trim();
      continue;
    }
    const fromMatch = trimmed.match(/^\[from\s+([^\]]+)\]\s*(.*)$/i);
    if (fromMatch) {
      const body = fromMatch[2]?.trim() ?? "";
      if (body) bullets.push(`- ${body}`);
      continue;
    }
    const italicFrom = trimmed.match(/^[-•]?\s*(.+?)\s*_\s*\(from [^)]+\)\s*_$/i);
    if (italicFrom?.[1]) {
      bullets.push(`- ${italicFrom[1].trim()}`);
      continue;
    }
    if (trimmed.startsWith("- ")) {
      bullets.push(trimmed);
      continue;
    }
    if (trimmed.startsWith("\u2022 ")) {
      bullets.push(`- ${trimmed.slice(2)}`);
      continue;
    }
    bullets.push(`- ${trimmed}`);
  }
  if (bullets.length === 0) {
    if (looksLikeSubgraphDump(stripped)) return "";
    return stripped.slice(0, maxChars);
  }
  return bullets.join("\n").slice(0, maxChars);
}
export function formatNodeBullet(n: StructuredRecallNode) {
  const body = (n.text ?? "").trim().replace(/\s+/g, " ");
  return `- ${body}`;
}
export function extractPersonNamesFromQuery(query: string): string[] {
  const names = /* @__PURE__ */ new Set();
  const titleCase = titleCaseLatinToken;
  const personCtx = extractPersonInContextFromQuery(query);
  if (personCtx?.person) names.add(personCtx.person);
  for (const q of extractQuotedPhrases(query)) names.add(q);
  for (const m of query.matchAll(PERSON_NAME_G)) {
    if (m[0]) names.add(m[0]);
  }
  for (const m of query.matchAll(
    /\b(?:are|au|is|has|for|de)\s+([a-zăâîșț]{2,}(?:\s+[a-zăâîșț]{2,}){1,2})\b/gi
  )) {
    const raw = m[1]?.trim() ?? "";
    if (!raw) continue;
    const capped = titleCase(raw);
    if (looksLikePersonName(capped)) names.add(capped);
  }
  return [...names];
}
export function filterStructuredRecallNodes(nodes: StructuredRecallNode[], query: string) {
  let filtered = nodes.filter((n) => !isRecallAuditMeta(n.text ?? ""));
  const ql = query.toLowerCase();
  const wantsUnpublished = /\bunpublished\b/.test(ql);
  const wantsPublished = /\bpublished\b/.test(ql.replace(/\bunpublished\b/g, ""));
  if (wantsUnpublished && !wantsPublished) {
    filtered = filtered.filter((n) => {
      const t = (n.text ?? "").toLowerCase();
      if (/\bunpublished\b/.test(t)) return true;
      if (/\bpublished\b/.test(t) && !/\bunpublished\b/.test(t)) return false;
      return true;
    });
  }
  const personCtx = extractPersonInContextFromQuery(query);
  if (personCtx) {
    const personParts = personCtx.person.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
    const scoped = filtered.filter((n) => {
      const t = (n.text ?? "").toLowerCase();
      if (!personParts.every((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t))) {
        return false;
      }
      if (personCtx.scope) {
        const scopeLower = personCtx.scope.toLowerCase();
        const scopeSlug = scopeLower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const scopeSpaced = scopeLower.replace(/-/g, " ");
        const scopeInText = t.includes(scopeLower) || scopeSpaced.length >= 4 && t.includes(scopeSpaced);
        const scopeInMeta = (n.engram?.toLowerCase().includes(scopeSlug) ?? false) || (n.graphId?.toLowerCase().includes(scopeSlug) ?? false);
        if (!scopeInText && !scopeInMeta) return false;
      }
      return true;
    });
    if (scoped.length > 0) filtered = scoped;
  }
  if (/\btodos?\b/.test(ql)) {
    filtered = filtered.filter((n) => {
      const t = (n.text ?? "").toLowerCase();
      if (/\bpublished to npm\b/.test(t)) return false;
      if (/\bgithub release\b/.test(t) && /\bpublished\b/.test(t)) return false;
      return true;
    });
  }
  if (/\b(tasks?|sarcini|deadlines?|termen)\b/i.test(ql) && /\b(team|echipei|echipa|members?|membri)\b/i.test(ql)) {
    const teamish = filtered.filter((n) => {
      const t = n.text ?? "";
      return /^#+\s+[A-ZĂÂÎȘȚ]/m.test(t) || /\b(tasks?|role|deadline|sarcini|rol|engineer|manager|lucru)\b/i.test(t) || /\b[A-ZĂÂÎȘȚ][a-zăâîșț]+ [A-ZĂÂÎȘȚ][a-zăâîșț]+/.test(t);
    });
    if (teamish.length > 0) filtered = teamish;
  }
  const isHowTo = isHowToQuestionText(ql);
  const wantsSkillsExplicit = /\b(?:(?:preview|walk)(?:_| )?skill|run the skill|execute the skill|skill procedure|procedur[aă])\b/i.test(ql) || /\b(skill|skilluri|sop)\b/i.test(ql) && !isHowTo;
  if (isHowTo && !wantsSkillsExplicit) {
    const withoutSkills = filtered.filter((n) => {
      const src = (n.sourceId ?? "").toLowerCase();
      const t = n.text ?? "";
      if (src.startsWith("skill:")) return false;
      if (/src:skill:/i.test(t)) return false;
      if (/^Step \d+:/im.test(t)) return false;
      if (/\b(?:enterprise-sales-prep|deployment-platform-ops|skill-dispatch)\b/i.test(t)) return false;
      return true;
    });
    if (withoutSkills.length > 0) filtered = withoutSkills;
  }
  const quoted = extractQuotedPhrases(query);
  if (quoted.length > 0) {
    return filtered.filter(
      (n) => quoted.some((q) => textMatchesPhrase(n.text ?? "", q))
    );
  }
  const multiWordPersons = extractPersonNamesFromQuery(query).filter((p) => p.includes(" "));
  if (multiWordPersons.length > 0) {
    return filtered.filter(
      (n) => multiWordPersons.some((person) => textMatchesPhrase(n.text ?? "", person))
    );
  }
  const singlePersons = extractPersonNamesFromQuery(query).filter((p) => !p.includes(" "));
  if (singlePersons.length > 0) {
    const withSingle = filtered.filter((n) => {
      const t = (n.text ?? "").toLowerCase();
      return singlePersons.some((person) => {
        const p = person.toLowerCase();
        return new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
      });
    });
    if (withSingle.length > 0) filtered = withSingle;
  }
  const personInQuery = query.match(/\b([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)?)\b/);
  if (personInQuery?.[1]) {
    const person = personInQuery[1].toLowerCase();
    const parts = person.split(/\s+/).filter((p) => p.length >= 3);
    const withPerson = filtered.filter((n) => {
      const t = (n.text ?? "").toLowerCase();
      return parts.every((p) => t.includes(p));
    });
    if (withPerson.length > 0) filtered = withPerson;
  }
  return filtered;
}
export function namesInStructuredNodes(nodes: StructuredRecallNode[]) {
  const names = /* @__PURE__ */ new Set();
  for (const n of nodes) {
    const t = n.text ?? "";
    for (const m of t.matchAll(/^#+\s*([^\n]+)/gm)) {
      const raw = m[1];
      if (!raw) continue;
      const head = raw.trim().split(/[:\-–]/)[0]?.trim() ?? "";
      if (head.length >= 3 && head.length <= 60) names.add(head.toLowerCase());
    }
    const owner = inferOwnerFromNode(n);
    if (owner !== "Unassigned") names.add(owner.toLowerCase());
  }
  return [...names];
}
export function exhaustiveResponseMissingNames(response: string, structuredNodes: StructuredRecallNode[]) {
  if (structuredNodes.length < 2) return false;
  const names = namesInStructuredNodes(structuredNodes);
  if (names.length < 2) return false;
  const rl = response.toLowerCase();
  let missing = 0;
  for (const name of names) {
    const parts = name.split(/\s+/).filter((p) => p.length >= 3);
    if (parts.length >= 2) {
      if (!parts.every((p) => rl.includes(p))) missing++;
    } else {
      const first = parts[0] ?? "";
      if (first.length >= 3 && !rl.includes(first)) missing++;
    }
  }
  return missing > 0;
}
var ROSTER_FORM_FIELD_LABELS = /* @__PURE__ */ new Set([
  "nume",
  "prenume",
  "email",
  "telefon",
  "mobil",
  "mail",
  "phone",
  "address",
  "adresa",
  "adres\u0103",
  "completa",
  "complet\u0103",
  "name",
  "firstname",
  "lastname",
  "invitati",
  "invita\u021Bi",
  "suplimentari",
  "numar",
  "num\u0103r",
  "optiuni",
  "op\u021Biuni",
  "updates",
  "sms",
  "mobile",
  "guest",
  "guests",
  "firstname",
  "lastname",
  "full",
  "complete",
  "field",
  "fields",
  "c\xE2mp",
  "camp",
  "formular",
  "form"
]);
var ROSTER_META_LABELS = /* @__PURE__ */ new Set([
  "owner",
  "owners",
  "member",
  "members",
  "team",
  "assignee",
  "assignees",
  "assigned",
  "attendee",
  "attendees",
  "participant",
  "participants",
  "speaker",
  "speakers",
  "board",
  "staff",
  "roster",
  "membri",
  "membru",
  "echipa",
  "echipei",
  "consilieri",
  "confirmare",
  "confirmat",
  "rsvp",
  "todo",
  "todos",
  "atribuiri",
  "moderator",
  "moderatoare",
  "founder",
  "fondator",
  "manager",
  "director",
  "chair",
  "lead",
  "unassigned"
]);
var ROSTER_LIST_LABEL_RE = /\b(?:owners?|members?|team members?|assignees?|assigned to|attendees?|participants?|speakers?|board members?|staff|roster|membri(?:i)?|consilieri|RSVP|confirm(?:ed|at|are)?|echipa|membri suplimentari)\b[^:\n]{0,48}:\s*([^\n.]+)/gi;
var ROSTER_ROLE_NAME_RE = /\b(?:moderator|moderatoare|chair|lead|founder|fondator|manager|director|owner|assignee|speaker)\b[^:\n]{0,30}[—–-]\s*([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){0,2})/gi;
export function looksLikePersonName(name: string) {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (/@|https?:|www\.|\.com\b|\.org\b|\.ro\b|\/Users\/|\.md\b/i.test(trimmed)) return false;
  if (/^\d|[\d]{4}-\d{2}/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  const trimmedLower = trimmed.toLowerCase();
  if (ROSTER_META_LABELS.has(trimmedLower) || ROSTER_FORM_FIELD_LABELS.has(trimmedLower)) return false;
  let nameLike = 0;
  let hasCapitalized = false;
  for (const w of words) {
    const wl = w.toLowerCase();
    if (ROSTER_META_LABELS.has(wl) || ROSTER_FORM_FIELD_LABELS.has(wl)) return false;
    if (isRecallQueryStopWord(wl) && words.length === 1) return false;
    if (["game", "press", "release", "todo", "target", "mission", "tier", "note", "on", "off"].includes(wl)) {
      return false;
    }
    if (/^[A-ZĂÂÎȘȚ]/.test(w)) hasCapitalized = true;
    if (/^[A-ZĂÂÎȘȚ][a-zăâîșț'’-]+$/.test(w) || /^[a-zăâîșț'’-]{2,}$/.test(w)) nameLike++;
  }
  if (nameLike === 0) return false;
  if (words.length === 1 && !hasCapitalized) return false;
  return true;
}
export function normalizeRosterDisplayName(raw) {
  return raw.replace(/^[\d.)\s]+/, "").replace(/\s*\(from[^)]*\)\s*$/i, "").replace(/\s*\([^)]{0,80}\)\s*$/, "").trim();
}
export function isSkippableRosterName(name) {
  return !looksLikePersonName(name);
}
export function dedupeRosterPrefixNames(names) {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const name of sorted) {
    const lower = name.toLowerCase();
    if (kept.some((k) => k.toLowerCase().startsWith(lower + " "))) continue;
    kept.push(name);
  }
  return kept.sort((a, b) => a.localeCompare(b));
}
export function extractTeamMembersFromNodes(nodes: StructuredRecallNode[]) {
  const seen = /* @__PURE__ */ new Map();
  const addName = (raw) => {
    const name = normalizeRosterDisplayName(raw);
    if (isSkippableRosterName(name)) return;
    const lower = name.toLowerCase();
    const prev = seen.get(lower);
    if (!prev || name.length > prev.length) seen.set(lower, name);
  };
  const parseList = (fragment) => {
    const cleaned = fragment.replace(/\(\+\d+\)/g, "");
    for (const part of cleaned.split(/\s*(?:\+|&|,| și | and )\s*/i)) {
      addName(part);
    }
  };
  for (const n of nodes) {
    const t = n.text ?? "";
    for (const m of t.matchAll(ROSTER_LIST_LABEL_RE)) {
      if (m[1]) parseList(m[1]);
    }
    for (const m of t.matchAll(ROSTER_ROLE_NAME_RE)) {
      if (m[1]) addName(m[1]);
    }
    for (const m of t.matchAll(
      /^[-*]\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){0,2})\s*(?:[–—-]\s*|\(|$)/gm
    )) {
      if (m[1]) addName(m[1]);
    }
    for (const m of t.matchAll(
      /^\d+\.\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){0,2})\s*(?:\(|[–—-])/gm
    )) {
      if (m[1]) addName(m[1]);
    }
    for (const m of t.matchAll(
      /^[-*]\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){1,2})\s*$/gm
    )) {
      if (m[1]) addName(m[1]);
    }
    const owner = inferOwnerFromNode(n);
    if (owner !== "Unassigned") addName(owner);
    for (const m of t.matchAll(/^#+\s*([^\n]+)/gm)) {
      const raw = m[1];
      if (!raw) continue;
      const head = raw.trim().split(/[:\-–]/)[0]?.trim() ?? "";
      if (!head || isSkippableRosterName(head)) continue;
      if (/^[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)?$/.test(head)) {
        addName(head);
      }
    }
  }
  return dedupeRosterPrefixNames([...seen.values()]);
}
export function rosterNodesFromBulletLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const body = trimmed.slice(2).trim();
    if (/\b(?:owners?|members?|membri|assignees?|attendees?|RSVP)\s*:/i.test(body) || /^[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){0,2}\s*(?:[–—-]|\(|$)/.test(body)) {
      out.push({ text: trimmed });
    }
  }
  return out;
}
export function inferTeamLabelFromQuery(query) {
  const m = query.match(/\b(?:echipei|echipa|team)\s+([a-z0-9][\w-]{2,})/i);
  return m?.[1];
}
export function formatTeamRosterList(nodes: StructuredRecallNode[], query: string) {
  const members = extractTeamMembersFromNodes(nodes);
  const teamLabel = inferTeamLabelFromQuery(query) ?? "the team";
  const fmt = formatterStrings(query);
  if (members.length === 0) {
    return fmt.rosterEmpty;
  }
  const header = fmt.rosterHeader(teamLabel);
  return `${header}

${members.map((m) => `- ${m}`).join("\n")}`;
}
var ROSTER_SECTION_BASE = "Core team";
var ROSTER_SECTION_BOARD = "Board / Advisory Council";
var DEFAULT_BOARD_ROLE = "Advisory Council / Board";
export function inferRosterSectionFromLine(line) {
  const l = line.toLowerCase();
  if (/consilieri consultativi|membri consilieri|^board\b/.test(l)) return ROSTER_SECTION_BOARD;
  if (/membri suplimentari|echipa cunoscută|echipa de bază|roluri suplimentare/.test(l)) {
    return ROSTER_SECTION_BASE;
  }
  return void 0;
}
export function extractTeamRosterEntries(nodes: StructuredRecallNode[]) {
  const seen = /* @__PURE__ */ new Map();
  const corpus = nodes.map((n) => n.text ?? "").join("\n");
  let section = ROSTER_SECTION_BASE;
  const add = (name, role, sec) => {
    const n = normalizeRosterDisplayName(name);
    if (isSkippableRosterName(n)) return;
    const r = role.trim().replace(/\s*\(from[^)]*\)\s*$/i, "").trim();
    if (!r) return;
    const s = sec ?? section;
    const key = n.toLowerCase();
    const prev = seen.get(key);
    if (!prev || r.length > prev.role.length) seen.set(key, { name: n, role: r, section: s });
  };
  for (const line of corpus.split("\n")) {
    const trimmed = line.trim();
    const sec = inferRosterSectionFromLine(trimmed);
    if (sec) section = sec;
    const roleBullet = trimmed.match(
      /^[-*]\s*([A-ZĂÂÎȘȚ][a-zăâîșț'’-]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț'’-]+){0,2})\s*[—–-]\s*(.+)$/
    );
    if (roleBullet?.[1] && roleBullet[2]) {
      add(roleBullet[1], roleBullet[2]);
      continue;
    }
    const inlineRole = trimmed.match(
      /([A-ZĂÂÎȘȚ][a-zăâîșț'’-]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț'’-]+){0,2})\s*[—–-]\s*(.+)$/
    );
    if (inlineRole?.[1] && inlineRole[2] && !inlineRole[2].startsWith("http")) {
      add(inlineRole[1], inlineRole[2]);
      continue;
    }
    const numberedRole = trimmed.match(
      /^\d+\.\s*([A-ZĂÂÎȘȚ][a-zăâîșț'’-]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț'’-]+){0,2})\s*[—–-]\s*(.+)$/
    );
    if (numberedRole?.[1] && numberedRole[2]) {
      add(numberedRole[1], numberedRole[2]);
      continue;
    }
    const tableRow = trimmed.match(
      /^\|\s*([A-ZĂÂÎȘȚ][^|]+?)\s*\|\s*([^|]+?)\s*\|/
    );
    if (tableRow?.[1] && tableRow[2] && !tableRow[1].includes("---")) {
      add(tableRow[1], tableRow[2]);
      continue;
    }
    const nameOnly = trimmed.match(
      /^[-*]\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){1,2})\s*$/
    );
    if (nameOnly?.[1] && section === ROSTER_SECTION_BOARD) {
      add(nameOnly[1], DEFAULT_BOARD_ROLE);
    }
  }
  for (const m of corpus.matchAll(ROSTER_ROLE_NAME_RE)) {
    if (!m[1]) continue;
    const prefix = m[0].replace(/\s*[—–-]\s*[A-ZĂÂÎȘȚ].*$/, "").trim();
    add(m[1], prefix);
  }
  const members = extractTeamMembersFromNodes(nodes);
  for (const member of members) {
    if (seen.has(member.toLowerCase())) continue;
    for (const line of corpus.split("\n")) {
      if (!textMatchesPhrase(line, member)) continue;
      const after = line.match(
        new RegExp(
          `${member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\u2014\u2013-]\\s*(.+)$`,
          "i"
        )
      );
      if (after?.[1]) {
        add(member, after[1]);
        break;
      }
      const roleLabel = line.match(
        /\b(?:rol|role|pozi[tț]ia|func[tț]ia|title|job)\s*:\s*([^\n,;]+)/i
      );
      if (roleLabel?.[1]) {
        add(member, roleLabel[1]);
        break;
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function formatTeamRosterWithRoles(nodes: StructuredRecallNode[], query: string) {
  const entries = extractTeamRosterEntries(nodes);
  const teamLabel = inferTeamLabelFromQuery(query) ?? "the team";
  const fmt = formatterStrings(query);
  if (entries.length === 0) {
    return formatTeamRosterList(nodes, query);
  }
  const header = fmt.teamHeader(teamLabel);
  const sections = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const list = sections.get(e.section) ?? [];
    list.push(e);
    sections.set(e.section, list);
  }
  const order = [ROSTER_SECTION_BASE, ROSTER_SECTION_BOARD];
  const sectionKeys = [
    ...order.filter((k) => sections.has(k)),
    ...[...sections.keys()].filter((k) => !order.includes(k)).sort()
  ];
  const body = sectionKeys.map((sec) => {
    const items = sections.get(sec) ?? [];
    const rows = items.map((e) => `| ${e.name} | ${e.role} |`).join("\n");
    return `### ${sec}

| Name | Role |
|------|------|
${rows}`;
  }).join("\n\n");
  const orgNote = sections.has(ROSTER_SECTION_BOARD) ? fmt.boardNote : "";
  return `${header}

${body}${orgNote}`;
}
export function formatPersonRoleAnswer(person: string, nodes: StructuredRecallNode[], _query: string) {
  const rosterEntry = extractTeamRosterEntries(nodes).find(
    (e) => e.name.toLowerCase() === person.toLowerCase() || textMatchesPhrase(e.name, person)
  );
  if (rosterEntry) {
    return `**${rosterEntry.name}** \u2014 ${rosterEntry.role}`;
  }
  const corpus = nodes.map((n) => n.text ?? "").join("\n");
  for (const line of corpus.split("\n")) {
    if (!textMatchesPhrase(line, person)) continue;
    const inline = line.match(
      new RegExp(
        `${person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\u2014\u2013-]\\s*(.+)$`,
        "i"
      )
    );
    if (inline?.[1]?.trim()) {
      const role = inline[1].trim().replace(/\s*\(from[^)]*\)\s*$/i, "");
      return `**${person}** \u2014 ${role}`;
    }
    const roleLabel = line.match(/\b(?:rol|role|pozi[tț]ia|func[tț]ia)\s*:\s*([^\n,;]+)/i);
    if (roleLabel?.[1]?.trim()) {
      return `**${person}** \u2014 ${roleLabel[1].trim()}`;
    }
  }
  const sections = extractPersonSectionsFromNodes(nodes);
  for (const [head, bullets] of sections) {
    if (!textMatchesPhrase(head, person)) continue;
    for (const b of bullets) {
      const roleLabel = b.match(/\b(?:rol|role|pozi[tț]ia|func[tț]ia)\s*:\s*([^\n]+)/i);
      if (roleLabel?.[1]) {
        return `**${head}** \u2014 ${roleLabel[1].trim()}`;
      }
    }
  }
  return null;
}
export function formatPersonInContextAnswer(person: string, nodes: StructuredRecallNode[], query: string) {
  const role = formatPersonRoleAnswer(person, nodes, query);
  if (role) return role;
  const tasks = formatPersonTaskAnswer(person, nodes, query);
  if (tasks) return tasks;
  const sections = extractPersonSectionsFromNodes(nodes);
  for (const [head, bullets] of sections) {
    if (!textMatchesPhrase(head, person)) continue;
    const body = bullets.slice(0, 5).join("\n");
    if (body.trim()) return `**${head}**
${body}`;
  }
  const lines = nodes.flatMap((n) => (n.text ?? "").split("\n")).map((l) => l.trim()).filter((l) => l.length > 0 && !isRecallAuditMeta(l) && textMatchesPhrase(l, person)).slice(0, 5);
  if (lines.length > 0) {
    const bullets = lines.map((l) => l.startsWith("-") ? l : `- ${l.replace(/^[-*]\s*/, "")}`);
    return `**${person}**
${bullets.join("\n")}`;
  }
  return null;
}
export function formatPersonTaskAnswer(person: string, nodes: StructuredRecallNode[], _query: string) {
  const sections = extractPersonSectionsFromNodes(nodes);
  for (const [head, bullets] of sections) {
    if (!textMatchesPhrase(head, person)) continue;
    const taskBullets = bullets.filter(
      (b) => /\b(rol|role|sarcini|tasks?|termen|deadline|lucru|week)\b/i.test(b)
    );
    const body = (taskBullets.length > 0 ? taskBullets : bullets).join("\n");
    if (!body.trim()) continue;
    return `**${head}**
${body}`;
  }
  const corpus = nodes.map((n) => n.text ?? "").join("\n");
  const lines = corpus.split("\n").filter((line) => textMatchesPhrase(line, person));
  if (lines.length > 0) {
    const bullets = lines.map((l) => l.trim()).filter((l) => l.startsWith("-") || /\b(rol|sarcini|tasks?|termen|deadline|t[aâ]ches?|tareas?|aufgaben)\b/i.test(l)).map((l) => l.startsWith("-") ? l : `- ${l}`);
    if (bullets.length > 0) {
      return `**${person}**
${bullets.join("\n")}`;
    }
  }
  return null;
}
export function extractPersonSectionsFromText(text) {
  const sections = /* @__PURE__ */ new Map();
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n(?=#{1,3}\s+)/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const headLine = lines[0]?.replace(/^#{1,3}\s+/, "").trim() ?? "";
    const head = headLine.split(/[:\-–]/)[0]?.trim() ?? "";
    if (!head || !looksLikePersonName(head)) continue;
    const bullets = lines.slice(1).map((line) => line.trim()).filter((line) => line.startsWith("-"));
    if (bullets.length === 0) continue;
    const prev = sections.get(head) ?? [];
    sections.set(head, [...prev, ...bullets]);
  }
  return sections;
}
export function extractPersonSectionsFromNodes(nodes) {
  const merged = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    const perNode = extractPersonSectionsFromText(n.text ?? "");
    for (const [name, bullets] of perNode) {
      const prev = merged.get(name) ?? [];
      merged.set(name, [...prev, ...bullets]);
    }
  }
  if (merged.size === 0) {
    return extractPersonSectionsFromText(nodes.map((n) => n.text ?? "").join("\n\n"));
  }
  return merged;
}
export function extractProjectScopeFromQuery(query: string) {
  const m = query.match(
    /\b(?:for|pentru|from|in|at|on|about|despre|din|de la)\s+([a-z0-9][\w-]{2,})/i
  );
  return m?.[1]?.toLowerCase() ?? null;
}
export function scopeMatchesText(scope, text, engram) {
  const t = text.toLowerCase();
  const slug = scope.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const compact = scope.replace(/[^a-z0-9]/g, "");
  const spaced = scope.replace(/-/g, " ");
  if (t.includes(scope)) return true;
  if (spaced.length >= 4 && t.includes(spaced)) return true;
  if (compact.length >= 6 && t.replace(/[^a-z0-9]/g, "").includes(compact)) return true;
  const eg = (engram ?? "").toLowerCase();
  if (slug.length >= 4 && (eg.includes(slug) || eg.includes(compact))) return true;
  return false;
}
export function isTodoLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[-*•]\s*\[[ xX]\]/.test(trimmed)) return true;
  if (/\bTODO\b/i.test(trimmed)) return true;
  if (/^[-*•]\s/.test(trimmed) && /\b(task|todo|deadline|due|termen|sarcin|lucru|fix|ship|review|draft)\b/i.test(trimmed)) {
    return true;
  }
  if (/^[-*•]\s/.test(trimmed) && /\*\*[^*]+\*\*\s*[—–-]/.test(trimmed)) return false;
  if (/^[-*•]\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)?\s*[—–-]/.test(trimmed)) {
    return false;
  }
  return false;
}
export function normalizeTodoBullet(line) {
  let t = line.trim();
  t = t.replace(/^\[[ xX]\]\s*/, "");
  t = t.replace(/^[-*•]\s*/, "");
  t = t.replace(/\s*\(from[^)]*\)\s*$/i, "");
  t = t.replace(/\s*_\s*\(from [^)]+\)\s*_$/i, "");
  return `- ${t.trim()}`;
}
export function extractTodoBulletsFromText(text: string, scope?: string | null) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isRecallAuditMeta(trimmed)) continue;
    if (scope && !scopeMatchesText(scope, trimmed)) {
      if (!isTodoLine(trimmed)) continue;
    }
    if (!isTodoLine(trimmed)) continue;
    if (/\bpublished to npm\b/i.test(trimmed)) continue;
    if (/\bgithub release\b/i.test(trimmed) && /\bpublished\b/i.test(trimmed)) continue;
    const bullet = normalizeTodoBullet(trimmed);
    const key = bullet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bullet);
  }
  return out;
}
export function formatProjectTodosAnswer(nodes: StructuredRecallNode[], query: string, projectScope?: string | null) {
  const scope = projectScope ?? extractProjectScopeFromQuery(query);
  let filtered = nodes.filter((n) => !isRecallAuditMeta(n.text ?? ""));
  if (scope) {
    const scoped = filtered.filter(
      (n) => scopeMatchesText(scope, n.text ?? "", n.engram ?? n.graphId)
    );
    if (scoped.length > 0) filtered = scoped;
  }
  const todos = [];
  const seen = /* @__PURE__ */ new Set();
  for (const n of filtered) {
    for (const bullet of extractTodoBulletsFromText(n.text ?? "", scope)) {
      const key = bullet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      todos.push(bullet);
    }
  }
  if (todos.length === 0) {
    for (const n of filtered) {
      for (const line of (n.text ?? "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ")) continue;
        if (/\b(tasks? this week|sarcini|deadline|termen|due|lucru)\b/i.test(trimmed)) {
          const bullet = normalizeTodoBullet(trimmed);
          const key = bullet.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            todos.push(bullet);
          }
        }
      }
    }
  }
  if (todos.length === 0) return null;
  const fmt = formatterStrings(query);
  const label = scope ? scope.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : fmt.projectFallback;
  const header = fmt.tasksHeader(label);
  return `${header}

${todos.join("\n")}`;
}

export type ObligationRecallRow = {
  engram?: string;
  obligationType?: string;
  expiresAt?: number;
  daysUntil?: number;
  overdue?: boolean;
  preview?: string;
};

function formatObligationDueLabel(ob: ObligationRecallRow): string {
  if (ob.overdue) {
    const days = ob.daysUntil ?? 0;
    return days < 0 ? `overdue by ${Math.abs(days)}d` : 'overdue';
  }
  const d = ob.daysUntil ?? 0;
  if (d <= 0) return 'due today';
  if (d === 1) return 'due tomorrow';
  return `due in ${d}d`;
}

/** Format recall_obligations rows — overdue vs due-soon sections. */
export function formatObligationsAnswer(obligations: ObligationRecallRow[], query: string): string | null {
  if (obligations.length === 0) return null;
  const wantsPastDue = /\b(?:past due|overdue)\b/i.test(query);
  const wantsTomorrow = /\btomorrow\b/i.test(query);
  let filtered = obligations;
  if (wantsPastDue && !wantsTomorrow) {
    filtered = obligations.filter((o) => o.overdue);
  } else if (wantsTomorrow && !wantsPastDue) {
    filtered = obligations.filter((o) => !o.overdue && (o.daysUntil ?? 99) <= 1);
  }
  if (filtered.length === 0) return null;

  const overdue = filtered.filter((o) => o.overdue);
  const upcoming = filtered.filter((o) => !o.overdue);
  const lines: string[] = [];
  const bullet = (o: ObligationRecallRow) => {
    const preview = (o.preview ?? '').trim().replace(/\s+/g, ' ');
    const engram = o.engram ? ` · ${o.engram}` : '';
    return `- ${preview || '(no preview)'} (${formatObligationDueLabel(o)}${engram})`;
  };
  if (overdue.length > 0) {
    lines.push('**Past due**', ...overdue.map(bullet));
  }
  if (upcoming.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(wantsTomorrow ? '**Due tomorrow**' : '**Due soon**', ...upcoming.map(bullet));
  }
  return lines.join('\n');
}

export function formatTeamTasksByPerson(nodes: StructuredRecallNode[], query: string) {
  const sections = extractPersonSectionsFromNodes(nodes);
  const fmt = formatterStrings(query);
  if (sections.size === 0) {
    const members = extractTeamMembersFromNodes(nodes);
    for (const member of members) {
      const first = member.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!first) continue;
      const bullets = nodes.filter((n) => (n.text ?? "").toLowerCase().includes(first)).map((n) => {
        const body2 = (n.text ?? "").trim().replace(/\s+/g, " ");
        return body2.startsWith("-") ? body2 : `- ${body2}`;
      });
      if (bullets.length > 0) sections.set(member, bullets);
    }
  }
  if (sections.size === 0) {
    return formatGroupedRecallList(nodes, query);
  }
  const header = fmt.teamTasksHeader;
  const body = [...sections.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, bullets]) => `### ${name}
${bullets.join("\n")}`).join("\n\n");
  return `${header}

${body}`;
}
export function responseClaimsUnattestedFullNames(response: string, structuredNodes: StructuredRecallNode[]) {
  if (structuredNodes.length === 0) return false;
  const corpus = structuredNodes.map((n) => (n.text ?? "").toLowerCase()).join("\n");
  const pairs = response.matchAll(/\b([A-ZĂÂÎȘȚ][a-zăâîșț]+)\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+)\b/g);
  for (const m of pairs) {
    if (!m[1] || !m[2]) continue;
    const full = `${m[1]} ${m[2]}`;
    if (!looksLikePersonName(full)) continue;
    if (!corpus.includes(full.toLowerCase())) return true;
  }
  return false;
}
export function responseMatchesQueryConstraints(response: string, query: string) {
  const quoted = extractQuotedPhrases(query);
  if (quoted.length > 0) {
    return quoted.some((q) => textMatchesPhrase(response, q));
  }
  const multi = extractPersonNamesFromQuery(query).filter((p) => p.includes(" "));
  if (multi.length > 0) {
    return multi.some((p) => textMatchesPhrase(response, p));
  }
  return true;
}
export function inferGroupDimension(query) {
  const m = query.match(
    /\bby\s+(team\s+members?|members?|person|people|owner|assignee|author|category|status|engram|project)\b/i
  );
  if (m?.[1]) return m[1].toLowerCase().replace(/\s+/g, " ");
  return "category";
}
export function inferOwnerFromNode(n: StructuredRecallNode) {
  const text = n.text ?? "";
  for (const m of text.matchAll(/^#+\s*([^\n]+)/gm)) {
    const raw = m[1];
    if (!raw) continue;
    const head = raw.trim().split(/[:\-–]/)[0]?.trim() ?? "";
    if (head && looksLikePersonName(head)) return head;
  }
  const patterns = [
    /\b(?:assignee|owner|assigned to|team member|member|for):\s*([^\n,;(\[]+)/i,
    /\b@([\w.-]+)/
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const name = m?.[1]?.trim();
    if (name && name.length <= 60) return name;
  }
  return "Unassigned";
}
export function formatStructuredRecallList(nodes: StructuredRecallNode[]) {
  if (nodes.length === 0) return "";
  return `Found **${nodes.length}** matching memor${nodes.length === 1 ? "y" : "ies"} in your cortex:

${nodes.map(formatNodeBullet).join("\n")}`;
}
export function formatGroupedRecallList(nodes: StructuredRecallNode[], query: string) {
  if (nodes.length === 0) return "";
  const dimension = inferGroupDimension(query);
  const groups = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    const key = inferOwnerFromNode(n);
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "Unassigned") return 1;
    if (b === "Unassigned") return -1;
    return a.localeCompare(b);
  });
  const sections = sortedKeys.map((key) => {
    const items = groups.get(key) ?? [];
    return `### ${key}
${items.map(formatNodeBullet).join("\n")}`;
  });
  return `Found **${nodes.length}** matching memor${nodes.length === 1 ? "y" : "ies"}, grouped by ${dimension}:

` + sections.join("\n\n");
}
export function looksGroupedResponse(text: string) {
  return /^#{1,3}\s+\S/m.test(text) || /^\*\*[^*\n]{2,60}\*\*\s*$/m.test(text);
}
export function skillSearchHaystack(skill: SkillListEntry) {
  const parts = [
    normalizeSkillDisplayLabel(skill.label),
    skill.searchText ?? ""
  ];
  return parts.join(" ").toLowerCase();
}
export function skillMatchesFilter(skill: SkillListEntry, keyword: string | null) {
  if (!keyword) return true;
  const hay = skillSearchHaystack(skill);
  const needle = keyword.toLowerCase();
  if (hay.includes(needle)) return true;
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 2);
  return tokens.length > 0 && tokens.every((t) => hay.includes(t));
}
export function filterSkillsByKeyword(skills: SkillListEntry[], keyword: string | null) {
  if (!keyword) return skills;
  return skills.filter((s) => skillMatchesFilter(s, keyword));
}
export function normalizeSkillDisplayLabel(label: string) {
  return label.replace(/^skill:\d+:/, "").replace(/-/g, " ").trim();
}
export function formatSkillList(skills: SkillListEntry[], query: string, keyword: string | null) {
  const fmt = formatterStrings(query);
  if (skills.length === 0) {
    return fmt.skillEmpty(keyword);
  }
  const lines = skills.map((s) => {
    const label = normalizeSkillDisplayLabel(s.label);
    const meta = [];
    if (s.trainedAt) {
      meta.push(`trained ${new Date(s.trainedAt).toLocaleDateString()}`);
    }
    if (s.vitality != null) meta.push(`vitality ${s.vitality}`);
    return meta.length > 0 ? `- **${label}** \xB7 ${meta.join(" \xB7 ")}` : `- **${label}**`;
  });
  const header = fmt.skillHeader(keyword, skills.length);
  return `${header}

${lines.join("\n")}`;
}
export function formatMcpToolList(tools: McpToolListEntry[], query: string, keyword: string | null, opts?: { showCategoryFooter?: boolean }) {
  const fmt = formatterStrings(query);
  if (tools.length === 0) {
    return fmt.mcpToolEmpty(keyword);
  }
  const lines = tools.map((t) => `- **${t.name}** \u2014 ${t.shortDescription}`);
  const header = fmt.mcpToolHeader(keyword, tools.length);
  const footer = opts?.showCategoryFooter === false ? "" : `

${fmt.mcpToolFooter}`;
  return `${header}

${lines.join("\n")}${footer}`;
}

export type RecentIngestSource = {
  ingestedAt: string;
  kind: string;
  label: string;
  engramName: string;
  graphId?: string;
  sourceId?: string;
};

/** `kind:timestamp-or-hash:humanLabel` ref prefixes (Clip:1782264776201:Title). */
const SOURCE_REF_TRIPLE_RE =
  /^(?:clip|file|url|skill|ai-conversation|ghampus|sharing|text|conversation|session|note|pdf|doc|message):(?:\d{10,}|[a-f0-9]{8,}):(.+)$/i;

/** Bare hash-style clip ids leaked into labels (`clip48757483583465`). */
const BARE_CLIP_HASH_RE = /^clip\d{10,}$/i;

/** Strip internal source ref prefix from a single display label. */
export function stripInternalSourceRefPrefix(label: string): string {
  const raw = label.trim();
  if (!raw) return raw;
  if (BARE_CLIP_HASH_RE.test(raw)) return '';
  const triple = raw.match(SOURCE_REF_TRIPLE_RE);
  if (triple?.[1]) {
    const title = triple[1].trim();
    if (/^skill:/i.test(raw)) return title.replace(/-/g, ' ').trim() || 'Skill';
    return title;
  }
  return raw;
}

/** Strip clip/source ref tokens and MCP wire suffixes from user-visible prose. */
export function stripLeakedSourceRefsFromUserText(text: string): string {
  return text
    .replace(/\s*\|\s*graph:\s*\S+(?:\s*\|\s*id:\s*\S+)?\s*/gi, ' ')
    .replace(
      /\b(?:clip|file|url|skill|ai-conversation|ghampus|sharing):(?:\d{10,}|[a-f0-9]{8,}):/gi,
      '',
    )
    .replace(/\bclip\d{10,}\b/gi, '')
    .replace(/\bsrc:(?:clip|skill|file|url):[\w:/.-]+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse MCP `recent` tool bullet rows (refs may contain spaces). */
export function parseRecentIngestMcpText(rawText: string): RecentIngestSource[] {
  const sources: RecentIngestSource[] = [];
  for (const line of rawText.split('\n')) {
    if (!line.startsWith('•')) continue;
    const withIds = line.match(
      /^•\s+(\S+)\s+\[([^\]]+)\]\s+(.+?)\s+\(([^)]+)\)\s+\|\s+graph:\s+(\S+)\s+\|\s+id:\s+(\S+)\s*$/,
    );
    if (withIds) {
      const label = stripInternalSourceRefPrefix(withIds[3].trim());
      if (!label) continue;
      sources.push({
        ingestedAt: withIds[1],
        kind: withIds[2],
        label,
        engramName: withIds[4],
        graphId: withIds[5],
        sourceId: withIds[6],
      });
      continue;
    }
    const legacy = line.match(/^•\s+(\S+)\s+\[([^\]]+)\]\s+(.+?)\s+\(([^)]+)\)\s*$/);
    if (legacy) {
      const label = stripInternalSourceRefPrefix(legacy[3].trim());
      if (!label) continue;
      sources.push({
        ingestedAt: legacy[1],
        kind: legacy[2],
        label,
        engramName: legacy[4],
      });
    }
  }
  return sources;
}

export function formatRecentIngestsSection(sources: RecentIngestSource[]): string {
  return sources.map((s, i) => {
    const date = s.ingestedAt.slice(0, 10);
    const label = stripInternalSourceRefPrefix(s.label);
    return `${i + 1}. ${date} · **${label}** (${s.engramName})`;
  }).join('\n');
}