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
    /\b(ce|cine|care|cum|c[aă]nd|unde|pentru|despre|din|sarcini|taskuri|echipa|membri|listeaz|arat[aă]|aminte[sș]te|spune|toate|roluri|exist[aă]|caut[aă]?|g[aă]se[sș]te|gaseste)\b/i,
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

/** User explicitly asked for a longer / detailed answer — multilingual. */
export const WANTS_EXPANDED_ANSWER_EN_RE =
  /\b(?:expand(?:ed|ing)?|elaborate|more detail(?:s)?|in depth|in-depth|explain more|tell me more|full answer|comprehensive|go deeper|give me details|detailed answer|thorough(?:ly)?)\b/i;
export const WANTS_EXPANDED_ANSWER_RO_RE =
  /(?:^|[\s,.:;(!-])(?:în detaliu|in detaliu|mai mult(?:e)?|detaliaz[aă]|extinde|explic[aă] mai mult|pe larg|r[aă]spuns complet)\b/i;

export function wantsExpandedAnswerText(text: string): boolean {
  return WANTS_EXPANDED_ANSWER_EN_RE.test(text) || WANTS_EXPANDED_ANSWER_RO_RE.test(text);
}

/** Simple who/what person or role lookup — default to one-sentence answers. */
export const SIMPLE_PERSON_LOOKUP_RE =
  /\b(?:who (?:can help|is|handles|owns|runs|leads|manages|should|would)|who's|who can|cine (?:e|este|poate|se ocup[aă]|controleaz[aă]|face|s[aă] ocup[aă]))(?=\s|$|[?.!,])/i;

export function isSimplePersonLookupQuestion(text: string): boolean {
  if (SIMPLE_PERSON_LOOKUP_RE.test(text)) return true;
  if (
    /\b(?:what is|who is|which is|ce este|ce e|cine e)\b/i.test(text)
    && !/\b(?:list|all|every|toate|show all|enumerate)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/** Hints that suppress default brevity (lists, rosters, skill walks, etc.). */
export type BriefModeHints = {
  wantsExhaustive?: boolean;
  wantsGrouped?: boolean;
  wantsTeamRoster?: boolean;
  wantsTeamTaskList?: boolean;
  wantsProjectTaskList?: boolean;
  wantsExplicitSkillWalk?: boolean;
  wantsSkillList?: boolean;
  wantsMcpToolList?: boolean;
};

/** Default Ghampus answers are brief unless user asked to expand or needs a structured list. */
export function shouldDefaultBriefAnswer(text: string, hints?: BriefModeHints): boolean {
  if (wantsExpandedAnswerText(text)) return false;
  if (hints?.wantsExhaustive) return false;
  if (hints?.wantsGrouped) return false;
  if (hints?.wantsTeamRoster) return false;
  if (hints?.wantsTeamTaskList) return false;
  if (hints?.wantsProjectTaskList) return false;
  if (hints?.wantsExplicitSkillWalk) return false;
  if (hints?.wantsSkillList) return false;
  if (hints?.wantsMcpToolList) return false;
  if (
    /\b(?:summarize|summary|rezum[aă]|compil|recap|recapitul)\b/i.test(text)
    && /\b(?:discussion|conversation|chat|discu[țt]|conversa[țt]|thread)\b/i.test(text)
  ) {
    return false;
  }
  return true;
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

/** Human-readable label for synthesis / polish prompts. */
export function responseLanguageLabel(lang: UserLanguage): string {
  if (lang === 'other') return 'the same language the user wrote in';
  return LANG_LABEL[lang];
}

/** Single-line LLM instruction — always names the detected user language when known. */
export function matchResponseLanguageInstruction(userText: string): string {
  const lang = detectUserMessageLanguage(userText);
  if (lang === 'other') {
    return 'Respond in the same language as the user\'s question.';
  }
  const label = LANG_LABEL[lang];
  return `Respond in ${label} — the user's question is in ${label}.`;
}

/**
 * Full LANGUAGE block for synthesis / polish — user query language overrides recall snippet language.
 */
export function buildResponseLanguageRulesBlock(userText: string): string {
  const lang = detectUserMessageLanguage(userText);
  if (lang === 'en') {
    return `LANGUAGE (mandatory — highest priority):
- The user's question is in English. Respond in English even if <cortex_data> or recall snippets are in Romanian, French, or another language.
- Translate or summarize foreign-language memory into natural English — do NOT echo Romanian (or other non-English) prose unless quoting a proper noun or title verbatim.
- Preserve person names and original book/work titles exactly as stored; everything else should be English.`;
  }
  if (lang === 'ro') {
    return `LANGUAGE (mandatory — highest priority):
- The user's question is in Romanian. Respond in Romanian even if some recall snippets are in English.
- Translate or summarize English memory into natural Romanian when needed — do NOT echo English prose unless quoting a proper noun or title verbatim.`;
  }
  if (lang === 'other') {
    return `LANGUAGE (mandatory): Match the language of the user's question — recall snippet language does not override it.`;
  }
  const label = LANG_LABEL[lang];
  return `LANGUAGE (mandatory — highest priority):
- The user's question is in ${label}. Respond in ${label} even if recall snippets are in another language.
- Translate or summarize memory content into ${label} as needed.`;
}

/**
 * True when the draft answer appears to be in a different language than the user's question.
 * Used to force polish when synthesis/formatter echoed recall language instead of query language.
 */
export function answerLanguageMismatchUserQuery(userText: string, answer: string): boolean {
  const userLang = detectUserMessageLanguage(userText);
  if (userLang === 'other') return false;

  const draft = answer.trim();
  if (!draft) return false;

  const answerLang = detectUserMessageLanguage(draft);
  if (answerLang === userLang || answerLang === 'other') return false;

  const userScore = scoreLanguage(draft, userLang);
  const answerScore = scoreLanguage(draft, answerLang);

  if (userLang === 'en') {
    if (/[ăâîșțĂÂÎȘȚ]/.test(draft)) return true;
    return answerLang === 'ro' && answerScore >= 2 && answerScore > userScore;
  }

  if (userLang === 'ro') {
    if (answerLang === 'en' && userScore === 0 && answerScore >= 2 && !/[ăâîșțĂÂÎȘȚ]/.test(draft)) {
      return true;
    }
    return answerLang !== 'ro' && userScore === 0 && answerScore >= 2;
  }

  return answerLang !== userLang && answerScore >= 2 && answerScore > userScore;
}

/** Extra synthesis/polish rules when the user asked in Romanian. */
export function buildRomanianContentRulesBlock(userText: string): string {
  if (detectUserMessageLanguage(userText) !== 'ro') return '';
  return `
ROMANIAN QUERY — content rules:
- Respond in Romanian.
- Do NOT invent English titles for Romanian book or work names — quote the original Romanian title from memory; if unsure of translation, state the title verbatim without translating.
- Preserve person names exactly as stored in recall — never merge spellings or invent corrupted variants (e.g. keep "Ungur Sandu" as-is; do not blend OCR misreads).`;
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
    || /^lembra(?:-|\s)?me\b/i.test(m)
  );
}

/**
 * Multi-word save imperatives at message start — not covered by first-word fuzzy match.
 * e.g. Romanian "ține minte …", French "souviens-toi …", Spanish "recuerda que …".
 */
const MULTILINGUAL_SAVE_PHRASE_RES: readonly RegExp[] = [
  /^(?:ține|tine)\s+minte(?:\s+(?:c[aă]|că|de|despre))?\s*/iu,
  /^(?:aminte[sș]te-te|noteaz[aă]-[țt]i)\s+/iu,
  /^(?:souviens(?:-|\s)?(?:toi|toit)?|retiens?|enregistre|garde)\s+/iu,
  /^(?:recuerda(?:\s+(?:que|lo|la|las|los|el|esto|eso))?|guarda(?:\s+(?:que|lo|la|esto|eso))?|anota(?:\s+(?:que|lo|la|esto|eso))?)\s+/iu,
  /^(?:merk(?:e)?\s+dir|speicher(?:e)?(?:\s+(?:das|dass|folgendes))?)\s+/iu,
  /^(?:ricorda(?:\s+(?:che|ci[oò]|questo|quello))?)\s+/iu,
  /^(?:lembra(?:-se|-te)?(?:\s+(?:de|que|disso|disto|isto|isso))?|guarda(?:\s+(?:que|isto|isso))?)\s+/iu,
];

/** Strip a leading multilingual save phrase; returns remainder + whether a phrase matched. */
export function stripMultilingualSavePhrasePrefix(msg: string): { stripped: string; matched: boolean } {
  const t = msg.trim();
  for (const re of MULTILINGUAL_SAVE_PHRASE_RES) {
    const m = t.match(re);
    if (m) {
      return { stripped: t.slice(m[0].length).trim(), matched: true };
    }
  }
  return { stripped: t, matched: false };
}

/** True when the message opens with a multilingual save imperative (not remind-me recall). */
export function hasMultilingualSavePhrase(msg: string): boolean {
  if (isRemindMeRecallQuery(msg)) return false;
  return stripMultilingualSavePhrasePrefix(msg).matched;
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

  // "what's your most recent context?" / "what context do you have"
  if (
    /\b(?:most recent|latest|current)\s+context\b/i.test(t)
    || /\bwhat(?:'?s|\s+is)\s+(?:your|the)\s+(?:context|recent context)\b/i.test(t)
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
    || /\bwhat'?s\s+(?:the\s+)?(?:todo|task|todos?|tasks?)\b/i.test(m)
    || /\b(?:todo|task|todos?|tasks?)\s+(?:on|in|for|from|at)\s+\S/i.test(m)
    || /\b(?:todos?|tasks?)\s+(?:due|overdue|past due)\b/i.test(m)
  );
}

/** User wants cortex searched again — retry the prior question, not a literal recall query. */
export function isMemorySearchRetryCommand(msg: string): boolean {
  const t = msg.trim().replace(/[?.!]+$/, '');
  if (t.split(/\s+/).length > 8) return false;
  return (
    /^(?:search|check|look(?:\s+(?:in|at|through|up))?|consult|use|try)\s+(?:my\s+)?(?:memory|memories|cortex|the cortex)$/i.test(t)
    || /^search\s+memory$/i.test(t)
    || /^(?:caut[aă]|verific[aă]|uit[aă]-te)\s+(?:în\s+)?(?:memor(?:ie|ii)|cortex)$/i.test(t)
    || /^(?:please\s+)?(?:search|check)\s+(?:my\s+)?memory$/i.test(t)
  );
}

/** Comparative / procedural advice — prefer attested memory over general-knowledge direct answer. */
export function isProceduralAdviceQuery(text: string): boolean {
  const t = text.trim().replace(/[?.!]+$/, '');
  if (t.split(/\s+/).length > 24) return false;
  if (/\b(?:capital of|define|what is the speed of)\b/i.test(t)) return false;
  return (
    /\b(?:vs\.?|versus|or)\b/i.test(t)
    || /\bwhich (?:is|way|method|approach)\b/i.test(t)
    || (
      /\b(?:walk|drive|wash|rinse|dry|step|procedure|sop)\b/i.test(t)
      && /\b(?:better|should|recommend|prefer)\b/i.test(t)
    )
  );
}

/** Advice, recommendation, or decision — must recall attested memory before answering. */
export function isAdviceOrDecisionQuery(text: string): boolean {
  const t = text.trim().replace(/[?.!]+$/, '');
  if (t.split(/\s+/).length > 28) return false;
  if (/\b(?:capital of|define|what is the speed of)\b/i.test(t)) return false;
  if (isProceduralAdviceQuery(t)) return true;
  return (
    /\bshould I\b/i.test(t)
    || /\b(?:is it|would it be) (?:better|ok(?:ay)?|safe|wise|worth)\b/i.test(t)
    || /\b(?:do you|would you) recommend\b/i.test(t)
    || /\bwhat (?:do you|would you) recommend\b/i.test(t)
    || /\b(?:better to|best to|prefer to)\b/i.test(t)
    || (
      /\b(?:can|could|may) I\b/i.test(t)
      && /\b(?:without|before|after|when|if|while)\b/i.test(t)
    )
    || /\bhow should I\b/i.test(t)
  );
}

/** Temporal todo/deadline lookup — prefer recall_obligations over broad recall. */
export function isTemporalTodoQuery(msg: string): boolean {
  const m = msg.trim();
  return TASK_NOUN_RE.test(m)
    && /\b(?:due|overdue|past due|tomorrow|today|this week|expir(?:e|ing|es)?|deadline)\b/i.test(m);
}

/** Meta / self / app-help categories that skip cortex recall. */
export type GhampusMetaCategory =
  | 'model_status'
  | 'ghampus_identity'
  | 'app_help'
  | 'general_knowledge'
  | 'chitchat';

const META_IDENTITY_SUBJECTS = new Set([
  'ghampus', 'graphnosis', 'graphnosis app', 'cortex', 'engram', 'engrams',
  'mcp', 'ollama', 'consent', 'synapse', 'sidecar',
]);

/** User scoped the question to a named engram or saved memory — must recall. */
export function hasEngramOrMemoryScopeInQuery(text: string): boolean {
  const t = text.trim();
  return (
    hasMemoryAnchorInQuery(t)
    || /\b(?:in|în|inside|within|din|from|de la)\s+\S+\s+engram\b/i.test(t)
    || /\bengram\s+[a-z0-9][\w-]{1,40}\b/i.test(t)
    || /\bghampus-tests\b/i.test(t)
    || /\b(?:eval product|seahorse codename|product version)\b/i.test(t)
    || /\b(?:what did I (?:say|tell|write|save|store)|remember when|ce am (?:spus|zis)|what did we (?:discuss|save|store))\b/i.test(t)
  );
}

/** Task, person, project, or search lookups — never treat as meta self-help. */
export function isPersonalMemoryLookupQuery(text: string): boolean {
  const t = text.trim();
  if (/^(?:what(?:'s| is) the capital of|care e capitala)\b/i.test(t)) return false;
  if (/^\d+\s*[\+\-\*\/×÷]\s*\d+\s*=?\s*$/.test(t.replace(/[?.!]+$/, ''))) return false;
  if (hasEngramOrMemoryScopeInQuery(t)) return true;
  if (isRemindMeRecallQuery(t)) return true;
  if (isScopedTaskListQuery(t)) return true;
  if (isTemporalTodoQuery(t)) return true;
  if (TASK_NOUN_RE.test(t) && TASK_SCOPE_PREPOSITIONS.test(t)) return true;
  const firstWord = (t.toLowerCase().split(/\s+/)[0] ?? '').replace(/[?.!,]+$/, '');
  if (isMultilingualSearchVerbFirstWord(firstWord)) return true;
  if (TEAM_NOUN_RE.test(t) && (TASK_NOUN_RE.test(t) || ROLE_NOUN_RE.test(t))) return true;
  if (ROLE_NOUN_RE.test(t) && PERSON_NAME_RE.test(t)) return true;
  if (
    /\b(?:who can help|who handles|who owns|who runs|who leads|cine (?:e|este|poate|se ocup[aă]))\b/i.test(t)
    && !/\b(?:ghampus|graphnosis)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /^(?:(?:what|how)\s+about|tell\s+me\s+about|(?:ce|spune(?:-mi)?)\s+(?:[sș]tii|stii)\s+despre)\s+/i.test(t)
    && !/^(?:(?:what|how)\s+about|tell\s+me\s+about)\s+(?:ghampus|graphnosis|mcp|ollama|consent)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /^(?:what|who)\s+(?:is|are)\s+/i.test(t)
    && PERSON_NAME_RE.test(t)
    && !/\bcapital of\b/i.test(t)
    && !/^(?:what|who)\s+(?:is|are)\s+(?:ghampus|graphnosis|mcp|ollama|consent)\b/i.test(t)
  ) {
    return true;
  }
  if (/\b(?:unpublished|writings|team|project|todo|task|sarcin|obligation|deadline|dashboard)\b/i.test(t)) {
    return true;
  }
  if (isAdviceOrDecisionQuery(t)) return true;
  return false;
}

function isMetaIdentityTopic(topic: string): boolean {
  const norm = topic.toLowerCase().replace(/\s+/g, ' ').trim();
  if (META_IDENTITY_SUBJECTS.has(norm)) return true;
  return /^(?:ghampus|graphnosis(?:\s+app)?|cortex|engrams?|mcp|ollama|consent|sidecar|synapse)$/i.test(norm);
}

function isModelStatusQuestion(text: string): boolean {
  const t = text.trim();
  return (
    /\b(?:what|which)\s+(?:model|llm|ai)\b/i.test(t)
    || /\b(?:what|which)\s+(?:model|llm)\s+(?:are you|do you|rus?ti|folose[sș]ti|using|running)\b/i.test(t)
    || /\b(?:model|llm)\s+(?:are you|do you|rus?ti|folose[sș]ti|using|running)\b/i.test(t)
    || /\bce\s+(?:model|llm)\b/i.test(t)
    || /\b(?:ollama|local llm)\s+model\b/i.test(t)
    || /\b(?:currently|right now|now)\b[\s\S]{0,30}\b(?:model|llm)\b/i.test(t)
    || /\b(?:model|llm)\b[\s\S]{0,30}\b(?:currently|right now|now)\b/i.test(t)
    || /\bwhat model are you using\b/i.test(t)
  );
}

function isGhampusIdentityQuestion(text: string): boolean {
  const t = text.trim().replace(/[?.!]+$/, '');
  return (
    /^(?:who are you|what are you|what is ghampus|what'?s ghampus|who is ghampus)\b/i.test(t)
    || /^(?:cine e[sș]ti|ce e[sș]ti|cine este ghampus|ce este ghampus)\b/i.test(t)
    || /\bwhat can you do\b/i.test(t)
    || /\bce po[tț]i face\b/i.test(t)
    || /\bare you claude\b/i.test(t)
    || /\b(?:local or cloud|on device|on-device|cloud or local)\b/i.test(t)
    || /\b(?:e[sș]ti|esti)\s+(?:local|cloud|claude)\b/i.test(t)
    || (
      /\b(?:what|which)\s+version\b/i.test(t)
      && /\b(?:graphnosis|ghampus)\b/i.test(t)
      && !/\b(?:eval|product|seahorse|codename|ghampus-tests)\b/i.test(t)
    )
    || (
      /^(?:what|who)\s+(?:is|are)\s+(?:ghampus|graphnosis)\b/i.test(t)
      && !hasEngramOrMemoryScopeInQuery(t)
    )
  );
}

function isAppHelpQuestion(text: string): boolean {
  const t = text.trim();
  if (/\bslash commands?\b/i.test(t)) return true;
  if (/\bhow does consent work\b/i.test(t) || /\bcum func[tț]ioneaz[aă] consim[tț][aă]m[aă]ntul\b/i.test(t)) {
    return true;
  }
  if (/\bwhat (?:is|are)\s+(?:mcp|model context protocol|sensitive engrams?|consent tiers?)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:ce este|ce sunt)\s+(?:mcp|engram(?:ul|uri)?|consim[tț][aă]m[aă]ntul)\b/i.test(t)) {
    return true;
  }
  if (
    isHowToQuestionText(t)
    && /\b(?:ollama|graphnosis|ghampus|engram|mcp|consent|settings?|cortex|synapse|local llm|model|memory studio|install)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /^(?:what|who)\s+(?:is|are)\s+\S/i.test(t)
    && isMetaIdentityTopic(t.replace(/^(?:what|who)\s+(?:is|are)\s+/i, '').trim())
  ) {
    return true;
  }
  return false;
}

function isGeneralKnowledgeQuestion(text: string): boolean {
  const t = text.trim().replace(/[?.!]+$/, '');
  if (/^\d+\s*[\+\-\*\/×÷]\s*\d+\s*=?\s*$/.test(t)) return true;
  if (/^[\d\s+\-*/().=]+\s*[=?]?\s*$/.test(t) && /[\+\-\*\/]/.test(t)) return true;
  if (/^(?:what(?:'s| is) the capital of|care e capitala)\b/i.test(t)) return true;
  if (
    /^(?:what is|what's|define|ce este)\s+/i.test(t)
    && !isMetaIdentityTopic(t.replace(/^(?:what is|what's|define|ce este)\s+/i, '').trim())
    && !PERSON_NAME_RE.test(t)
    && !TEAM_NOUN_RE.test(t)
    && !TASK_NOUN_RE.test(t)
    && t.split(/\s+/).length <= 12
  ) {
    const subject = t.replace(/^(?:what is|what's|define|ce este)\s+/i, '').trim();
    if (subject.length >= 2 && !/\b(?:my|mine|our|team|project|task|todo|sarcin|echipa|membru)\b/i.test(t)) {
      return true;
    }
  }
  return false;
}

function isChitchatMessage(text: string): boolean {
  const t = text.trim().replace(/[?.!]+$/, '');
  if (!t || t.split(/\s+/).length > 8) return false;
  return (
    /^(?:hi|hello|hey|thanks|thank you|thx|bye|goodbye|good morning|good night|salut|bun[aă]|mul[tț]umesc|la revedere|merci|danke|hola|ciao)[!.?\s]*$/i.test(t)
    || /^(?:how are you|what'?s up|ce mai faci)\??$/i.test(t)
  );
}

/**
 * Detect meta / app / general-knowledge questions that should NOT recall cortex.
 * Returns null when the message needs personal memory research.
 */
export function detectGhampusMetaCategory(text: string): GhampusMetaCategory | null {
  const t = text.trim();
  if (!t) return null;
  if (isPersonalMemoryLookupQuery(t)) return null;
  if (isMetaChallengeQuery(t)) return null;
  if (isConversationContextQuery(t)) return null;

  if (isModelStatusQuestion(t)) return 'model_status';
  if (isGhampusIdentityQuestion(t)) return 'ghampus_identity';
  if (isAppHelpQuestion(t)) return 'app_help';
  if (isChitchatMessage(t)) return 'chitchat';
  if (isGeneralKnowledgeQuestion(t)) return 'general_knowledge';
  return null;
}

/** True when the user question should skip recall tools and answer directly. */
export function isNonMemoryQuestion(text: string): boolean {
  return detectGhampusMetaCategory(text) !== null;
}

/** User-facing copy when `/insights` has nothing pending yet. */
export function buildInsightsEmptyGuidance(): string {
  return (
    'No pending **Foresight insights** yet.\n\n'
    + 'Insights appear when the background brain loop runs (about every 6 hours with Local LLM enabled). '
    + 'They surface non-obvious patterns, gaps, and conflicts across your engrams.\n\n'
    + '**What you can do now:**\n'
    + '- Open **Foresight → Insights** to watch for new items\n'
    + '- Run a **consistency audit** (`/compare` or ask me to check contradictions)\n'
    + '- Enable Local LLM in **Settings → AI → Models** if it is off\n'
    + '- Ask me for **proactive tips** after you ingest new memories'
  );
}
