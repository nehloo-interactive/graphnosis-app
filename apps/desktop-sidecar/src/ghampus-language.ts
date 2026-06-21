/**
 * Ghampus user-message language detection — lightweight heuristic for routing
 * and formatter locale selection. Not a full NLP detector; script + function
 * words + diacritics. LLM synthesis/polish uses matchResponseLanguageInstruction.
 */

export type UserLanguage = 'en' | 'ro' | 'fr' | 'es' | 'de' | 'other';

const LANG_LABEL: Record<Exclude<UserLanguage, 'other'>, string> = {
  en: 'English',
  ro: 'Romanian',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
};

/** Function-word / morphology signals per language (examples, not exhaustive). */
const LANG_SIGNALS: Record<Exclude<UserLanguage, 'other'>, RegExp[]> = {
  en: [
    /\b(what|who|how|when|where|which|why|for|from|about|tasks?|todos?|team|members?|list|show|find|tell|remember|give me)\b/i,
  ],
  ro: [
    /\b(ce|cine|care|cum|c[aă]nd|unde|pentru|despre|din|sarcini|taskuri|echipa|membri|listeaz|arat[aă]|aminte[sș]te|spune|toate|roluri|exist[aă])\b/i,
    /[ăâîșțĂÂÎȘȚ]/,
  ],
  fr: [
    /\b(qui|que|quoi|comment|quand|o[uù]|pour|des|t[aâ]ches?|équipe|membres|liste|montre|dis-moi|rappelle|est-ce)\b/i,
    /[àâçéèêëïîôùûü]/i,
  ],
  es: [
    /\b(qu[eé]|qui[eé]n|c[oó]mo|cu[aá]ndo|d[oó]nde|para|tareas?|equipo|miembros|lista|muestra|recu[eé]rdame|sobre)\b/i,
    /[áéíóúñ¿¡]/i,
  ],
  de: [
    /\b(was|wer|wie|wann|wo|w[fü]r|aufgaben|team|mitglieder|liste|zeig|merke|erinnere|[uü]ber)\b/i,
    /[äöüß]/i,
  ],
};

/** Non-Latin scripts — treat as non-English; LLM matches user language. */
function scriptHint(text: string): UserLanguage | null {
  if (/[\u0400-\u04FF]/.test(text)) return 'other';
  if (/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'other';
  if (/[\u0600-\u06FF]/.test(text)) return 'other';
  if (/[\u0590-\u05FF]/.test(text)) return 'other';
  return null;
}

function scoreLanguage(text: string, lang: Exclude<UserLanguage, 'other'>): number {
  let score = 0;
  for (const re of LANG_SIGNALS[lang]) {
    if (re.test(text)) score += 1;
  }
  return score;
}

/**
 * Detect the likely language of a user message (simple heuristic).
 * Defaults to English when ambiguous.
 */
export function detectUserMessageLanguage(text: string): UserLanguage {
  const trimmed = text.trim();
  if (!trimmed) return 'en';

  const script = scriptHint(trimmed);
  if (script) return script;

  const scores: Record<Exclude<UserLanguage, 'other'>, number> = {
    en: scoreLanguage(trimmed, 'en'),
    ro: scoreLanguage(trimmed, 'ro'),
    fr: scoreLanguage(trimmed, 'fr'),
    es: scoreLanguage(trimmed, 'es'),
    de: scoreLanguage(trimmed, 'de'),
  };

  let best: UserLanguage = 'en';
  let bestScore = scores.en;
  for (const lang of ['ro', 'fr', 'es', 'de'] as const) {
    if (scores[lang] > bestScore) {
      bestScore = scores[lang];
      best = lang;
    }
  }
  return bestScore > 0 ? best : 'en';
}

/** Latin extended alphabet — person names / tokens (Romanian, French, etc.). */
export const PERSON_NAME_RE =
  /\b[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)?\b/;

export const PERSON_NAME_G = new RegExp(PERSON_NAME_RE.source, 'g');

export const WORD_TOKEN_RE = /[a-zăâîșț0-9]{2,}/gi;
export const WORD_TOKEN_RE_MIN3 = /[a-zăâîșț0-9]{3,}/gi;

/** Title-case a person token while preserving diacritics. */
export function titleCaseLatinToken(s: string): string {
  return s.replace(/(?:^|\s)([a-zăâîșț])/g, (m, c) => m.replace(c, c.toUpperCase()));
}

/** How-to / setup questions across common languages. */
export const HOW_TO_QUESTION_RE =
  /\b(?:how (?:do|can|to|should)|cum (?:pot|se|fac|configurez|s[aă] configurez)|comment (?:faire|configurer)|c[oó]mo (?:puedo|se|hacer|configurar)|wie (?:kann|konfiguriere|richte))\b/i;

export function isHowToQuestionText(text: string): boolean {
  return HOW_TO_QUESTION_RE.test(text);
}

/** User asked for brevity — multilingual. */
export const WANTS_BRIEF_ANSWER_RE =
  /\b(be brief|keep it brief|short answer|quick answer|concise|tldr|pe scurt|scurt(?:ă)?|rezumat|bref|r[eé]sum[eé]|kurz|resumen)\b/i;

export function wantsBriefAnswerText(text: string): boolean {
  return WANTS_BRIEF_ANSWER_RE.test(text);
}

/** First-word list/show verbs — never fuzzy-match save verbs. */
export const MULTILINGUAL_LIST_VERB_PREFIX_RE =
  /^(?:listeaz|arat|lista|montre|muestra|zeig|enumere)/i;

export function isMultilingualListVerbFirstWord(firstWord: string): boolean {
  return MULTILINGUAL_LIST_VERB_PREFIX_RE.test(firstWord);
}

/** First-word search/find verbs — recall, never create_engram or fuzzy save. */
export const MULTILINGUAL_SEARCH_VERB_PREFIX_RE =
  /^(?:search|find|lookup|look|caut|g[aă]se[sș]|gaseste|busca|cherche|suche|seek)/i;

export function isMultilingualSearchVerbFirstWord(firstWord: string): boolean {
  const bare = firstWord.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[?.!,]+$/, '');
  return MULTILINGUAL_SEARCH_VERB_PREFIX_RE.test(bare) || MULTILINGUAL_SEARCH_VERB_PREFIX_RE.test(firstWord);
}

/** Question openers in recall guards — not save imperatives. */
export const MULTILINGUAL_RECALL_QUESTION_RE =
  /\b(cine|ce|care|qui|que|quoi|qu[eé]|was|wer|what|who|which)\b/i;

/** Team / roster nouns for recall routing and filtering. */
export const TEAM_NOUN_RE =
  /\b(team|teams|echipei|echipa|members?|membri|board|consilieri|owners?|assignees?)\b/i;

/** Task / deadline nouns for recall routing. */
export const TASK_DEADLINE_NOUN_RE =
  /\b(todos?|tasks?|deadlines?|working on|sarcini|sarcinile|termen|termenul|termene|lucru|lucr[aă]t|deadline|obligations?|t[aâ]ches?|tareas?|aufgaben)\b/i;

/** Role nouns for person-role queries. */
export const ROLE_NOUN_RE =
  /\b(roluri|rolurile|rol\b|roles?|ce rol|what role|pozi[tț]ia|func[tț]ia|job|title|ocup[aă])\b/i;

/** Single-line LLM instruction — always universal; optional hint when confident. */
export function matchResponseLanguageInstruction(userText: string): string {
  const lang = detectUserMessageLanguage(userText);
  if (lang !== 'en' && lang !== 'other') {
    const label = LANG_LABEL[lang];
    return `Respond in ${label} since the user asked in ${label}.`;
  }
  return 'Match the language of the user\'s question.';
}

/** "Remind me …" recall phrasing — not an explicit save (multilingual). */
export function isRemindMeRecallQuery(msg: string): boolean {
  const m = msg.trim();
  return (
    /^aminte[s\u0219\u015fşș\u0218\u015e]te-mi\b/iu.test(m)
    || /^remind me\b/i.test(m)
    || /^rappelle(?:-|\s)?moi\b/i.test(m)
    || /^recu[eé]rdame\b/i.test(m)
    || /^erinnere(?:\s+)?mich\b/i.test(m)
    || /^ricordami\b/i.test(m)
  );
}

/** Multilingual question openers — first word signals recall, not save. */
export const MULTILINGUAL_QUESTION_OPENERS = new Set([
  // English
  'what', 'who', 'whom', 'which', 'where', 'when', 'why', 'how', 'show', 'find', 'list', 'tell', 'give', 'any', 'all',
  // Romanian
  'ce', 'cine', 'care', 'cum', 'când', 'cand', 'unde', 'cât', 'cat', 'spune', 'există', 'exista', 'toate', 'listeaz', 'listeaza', 'listează', 'arat', 'arata', 'arată', 'enumere',
  // French
  'qui', 'que', 'quoi', 'comment', 'quand', 'où', 'ou', 'montre', 'liste', 'dis',
  // Spanish
  'qué', 'que', 'quién', 'quien', 'cómo', 'como', 'cuándo', 'cuando', 'dónde', 'donde', 'muestra', 'lista',
  // German
  'was', 'wer', 'wie', 'wann', 'wo', 'zeig', 'liste',
]);

/** Scope prepositions for task/todo list queries (any language). */
export const TASK_SCOPE_PREPOSITIONS =
  /\b(?:for|of|from|in|at|on|about|regarding|re|pentru|despre|din|de la|pour|des|de|para|por|für|über|über)\s+\S/i;

/** Task/todo nouns across common languages. */
export const TASK_NOUN_RE =
  /\b(?:todos?|tasks?|todo lists?|task lists?|sarcini(?:le)?|taskuri(?:le)?|t[aâ]ches?|aufgaben|tareas?)\b/i;

/** User explicitly anchors the question to saved cortex memory — not this chat. */
export function hasMemoryAnchorInQuery(text: string): boolean {
  const t = text.trim();
  return (
    /\b(?:what|ce|qu[eé]|was|lo que)\s+(?:I|we|mi(?:s)?|am|ai|nos(?:otros)?|ich|wir)\s+(?:saved|stored|remembered|salvat|păstrat|păstrat|guard(?:ado|é|e|ados)|enregistr(?:é|e)|gespeichert)\b/i.test(t)
    || /\b(?:what|ce|qu[eé]|was)\s+(?:did|do|have)\s+(?:I|we|mi(?:s)?)\s+(?:save|saved|store|stored|remember|remembered)\b/i.test(t)
    || /\b(?:what did I tell you about|ce [ți]?am (?:spus|zis) despre|what did we save about|lo que guard(?:é|e) sobre)\b/i.test(t)
    || /\b(?:in|din|de|en|dans|in)\s+(?:my\s+)?(?:memor(?:y|ies|ie|ii)|memorie|memorii|cortex|engrams?|engram)\b/i.test(t)
    || /\b(?:from|din|de)\s+(?:my\s+)?(?:saved|stored|salvat(?:e|ă)?|guardad[oa]s?)\b/i.test(t)
    || /\b(?:check|search|look (?:up|in)|find (?:in|from))\s+(?:my\s+)?(?:memory|memorie|cortex)\b/i.test(t)
  );
}

/** Meta pronouns anchoring to the current Ghampus thread (not cortex). */
const CONVERSATION_META_PRONOUN_RE =
  /\b(?:our|we|us|my|this|these|aceast[aă]|acest(?:a|e)?|noastr[aăe]|notre|nuestr[oa]|diese[rs]?|dies(?:em|er|es)?)\b/i;

/** Discussion / conversation nouns without requiring English. */
const CONVERSATION_TOPIC_NOUN_RE =
  /\b(?:discussion(?:s)?|conversation(?:s)?|conversat(?:ion|ions?|ii|iile|iilor)?|discu[țt](?:ie|ii|iilor|ă|a)?|chat(?:s|ul)?|dialog(?:ue)?s?|gespr[aä]ch(?:e)?|pl[aă]tic[aă]|thread|session|sesi(?:une|ón)?)\b/i;

/**
 * User asks about THIS Ghampus chat session — not cortex memories.
 * Language-agnostic; returns false when query anchors to saved memory.
 */
export function isConversationContextQuery(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (hasMemoryAnchorInQuery(t)) return false;

  // Explicit chat-session anchors
  if (
    /\b(?:in this|in our|în aceast[aă]|en esta|in dieser)\s+(?:chat|conversation|thread|session|discu[țt]ie|conversa[țt]ie|sesi(?:une|ón))\b/i.test(t)
  ) {
    return true;
  }

  // "what we discussed / talked about" (no memory anchor)
  if (
    /\b(?:what|ce|qu[eé]|was)\s+(?:we|am|nos(?:otros)?|wir)\s+(?:talked|discussed|said|vorbit|discutat|spus|hablamos|discutimos|parl(?:é|e|ons|amos|ado))\b/i.test(t)
    || /\b(?:what we'?ve (?:talked|discussed|been talking)|ce am (?:discutat|vorbit)|lo que (?:hemos )?(?:hablado|discutido))\b/i.test(t)
  ) {
    return true;
  }

  // Meta pronoun + discussion/conversation noun
  if (CONVERSATION_META_PRONOUN_RE.test(t) && CONVERSATION_TOPIC_NOUN_RE.test(t)) {
    // "our past discussions" / "discuțiile noastre" / "notre conversation"
    if (
      /\b(?:past|previous|earlier|recent|anterioar(?:e|ă)|reciente|précédent|vergangene?)\b/i.test(t)
      || /\b(?:our|noastr[aăe]|notre|nuestr[oa])\b/i.test(t)
      || /\b(?:summarize|summary|sum(?:marize|ar|ariza)|rezum[aă]|compil(?:e|a|er)|list(?:eaz[aă])?)\b/i.test(t)
    ) {
      return true;
    }
  }

  // "issues/problems you noticed in our discussion/chat"
  if (
    /\b(?:issues?|problems?|probleme|buguri|observa[țt]ii|points?|things?|items?)\b/i.test(t)
    && /\b(?:you (?:noticed|found|saw|mentioned|raised)|ai observat|notaste|remarqu(?:é|e)|festgestellt)\b/i.test(t)
    && (CONVERSATION_META_PRONOUN_RE.test(t) || CONVERSATION_TOPIC_NOUN_RE.test(t))
  ) {
    return true;
  }

  // Summarize / compile / list about our/this conversation
  if (
    /\b(?:summarize|summary|sum(?:marize|ar|ariza)|rezum[aă]|compil(?:e|a|er)|recap|recapitul(?:a|e))\b/i.test(t)
    && CONVERSATION_META_PRONOUN_RE.test(t)
    && CONVERSATION_TOPIC_NOUN_RE.test(t)
  ) {
    return true;
  }

  // Bare "discussions/conversation" with meta pronoun (e.g. "our past discussions")
  if (
    CONVERSATION_META_PRONOUN_RE.test(t)
    && /\b(?:past|previous|earlier|recent|anterioar(?:e|ă))\s+(?:discussion|discussions|conversation|conversations|discu[țt]i(?:i|ile)|conversa[țt]i(?:i|ile))\b/i.test(t)
  ) {
    return true;
  }

  return false;
}

/**
 * User critiques Ghampus answer quality, routing, or cross-engram noise —
 * answer from chat transcript only; do NOT recall cortex.
 */
export function isMetaChallengeQuery(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  const critiquePatterns: RegExp[] = [
    /\bwhy did you add\b/i,
    /\bwhy did ghampus add\b/i,
    /\bwhy did you (?:include|pull|bring|use|cite|mention)\b/i,
    /\bwhy (?:didn'?t|did not|don'?t) you find\b/i,
    /\bwhy you didn'?t find\b/i,
    /\bwhy didn'?t you find\b/i,
    /\bthen why\b.*\b(?:didn'?t|did not|don'?t|not)\b.*\bfind\b/i,
    /\birrelevant content\b/i,
    /\bwrong engram\b/i,
    /\bfrom another engram\b/i,
    /\bfrom a different engram\b/i,
    /\bdoesn'?t belong\b/i,
    /\bdon'?t belong\b/i,
    /\bnot related to my question\b/i,
    /\bhave (?:nothing|anything) in common\b/i,
    /\bdoesn'?t have (?:things|anything) in common\b/i,
    /\byou hallucinated\b/i,
    /\byou (?:made|invented) (?:that|this) up\b/i,
    /\bthat wasn'?t in my memory\b/i,
    /\bnot in my (?:memory|memories|cortex)\b/i,
    /\bcross[- ]engram noise\b/i,
    /\bunrelated (?:content|memor(?:y|ies))\b/i,
    /\boff[- ]topic (?:content|memor(?:y|ies))\b/i,
    // Romanian
    /\bde ce ai (?:ad[aă]ugat|pus|inclus|menționat|citat)\b/i,
    /\bcon[țt]inut irelevant\b/i,
    /\bengram gre[sș]it\b/i,
    /\bdin alt(?:ul)? engram\b/i,
    /\bnu (?:apar[țt]ine|e relevant)\b/i,
    /\bai halucinat\b/i,
    /\bnu era [iî]n memoria mea\b/i,
    /\bnu (?:are|au) leg[aă]tur[aă]\b/i,
    // Recall miss / language hypothesis critiques
    /\bde ce nu ai g[aă]sit\b/i,
    /\bbecause the memor(?:y|ies) were in\b/i,
    /\b(?:previous|prior|last|earlier) prompt\b/i,
  ];

  if (!critiquePatterns.some((re) => re.test(t))) return false;

  // "previous prompt" alone is too broad — require a why/how critique cue
  if (
    /\b(?:previous|prior|last|earlier) prompt\b/i.test(t)
    && !/\b(?:why|how|de ce|cum)\b/i.test(t)
  ) {
    return false;
  }

  // Fresh memory lookup — not a critique of Ghampus behavior
  if (
    /^(?:what|ce|which|where|who|cine|care)\s+.+\s+(?:in|from|din)\s+(?:my\s+)?(?:memory|memorie|cortex|engram)/i.test(t)
    && !/\b(?:why did you|de ce ai)\b/i.test(t)
  ) {
    return false;
  }

  return true;
}

/** True when message asks for a scoped task/todo list (not a save). */
export function isScopedTaskListQuery(msg: string): boolean {
  const m = msg.trim();
  if (!TASK_NOUN_RE.test(m)) return false;
  return (
    TASK_SCOPE_PREPOSITIONS.test(m)
    || /^(?:todos?|tasks?|sarcini(?:le)?|t[aâ]ches?|tareas?|aufgaben)\b/i.test(m)
    || /^(?:ce|care|what|which|quoi|qué|que|was)\s+(?:task|todo|sarcin|t[aâ]che|tarea|aufgab)/i.test(m)
    || /\b(?:what|which)\s+(?:are\s+)?(?:my\s+)?(?:the\s+)?(?:todos?|tasks?)\b/i.test(m)
    || /\b(?:todos?|tasks?)\s+(?:due|overdue|past due)\b/i.test(m)
  );
}

/** Temporal todo/deadline lookup — prefer recall_obligations over broad recall. */
export function isTemporalTodoQuery(msg: string): boolean {
  const m = msg.trim();
  return TASK_NOUN_RE.test(m)
    && /\b(?:due|overdue|past due|tomorrow|today|this week|expir(?:e|ing|es)?|deadline)\b/i.test(m);
}
