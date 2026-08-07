// Standard test fixtures for the consistency suite.
//
// ALL CONTENT HERE IS SYNTHETIC. Every person, organisation and event name is
// invented for this suite; none refers to a real individual or body. This repo
// is PUBLIC — do not paste real notes, rosters or correspondence in here, and
// do not "improve" a fixture by making it real.
//
// The shapes are chosen deliberately, and are what the tests actually depend on:
//   - a Romanian-language roster and event note, so entity anchoring and recall
//     are exercised on non-English text;
//   - one surname carrying a diacritic ("Mareș") so ASCII-folding has something
//     to fold ("Mares");
//   - one given name ("Tudor") distinctive enough to be queried on its own;
//   - one person ("Paul Nistor") with no connection to publishing, so the
//     anchoring tests have a negative case.
// Keep them stable — many tests assert on specific names appearing in
// specific nodes.

export const ROSTER = `# Echipa Meridian Press — 10 roluri suplimentare
— Tudor Mareș — Publishers Liaison
— Elena Vintilescu — Strategy Consultant
— Sorina Dobrescu — Consilier Cultural (și gazda MeridianTALKS #1 cu Ioana Radu)
— Carmen Oltean — Manager Resurse Umane
— Ioana Radu — Global Community Manager
— Livia Neagoe — Moderator events
— Andrei Munteanu — Tech Lead
— Delia Ionescu — Editorial Assistant
— Vlad Ardelean — Operations
— Raluca Feraru — Outreach`;

export const EVENT = `# MeridianTALKS #2 — Livia/Otilia Neagoe, „Young Voices Forum"
MODERATOARE (probabil, neconfirmat): Sorina Dobrescu (aceeași gazdă ca la MeridianTALKS #1 cu Ioana Radu).
Tema: empowerment în comunitatea autoarelor tinere.
Data: TBD — verificat cu Tudor Mareș pentru calendar.`;

export const DOCS_RETURN = `# How return values work
The Return type describes what a function gives back. Used throughout the
Graphnosis SDK. Return values are typed and validated at the boundary.`;

export const DOCS_HOWITWORKS = `# How it works
Two independent paths to your data: lexical TF-IDF and dense embeddings.
The recall layer fuses both before applying entity anchoring and federation budget.`;

export const PEOPLE_PAUL = `# Paul Nistor
Met in 2023. Works at a coffee place near the office. No connection to publishing.
Recommended a book once: "The Pragmatic Programmer".`;

export const SENSITIVE_NOTE = `# Codeword for the safe
The codeword to open the safe is alpha-bravo-charlie-7. Never share with anyone.
Backup phrase: orange-mountain-river-12.`;

// Long-content fixture for testing inspectNodes contentPreview truncation.
// "Tudor" deliberately placed past character 500 — anchoring's
// selectAnchorNodes only sees the preview, so this should surface as an
// SDK note about the 500-char limit if it misses the entity.
export const LONG_NODE = `# Long meeting notes (week 47)
` + 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(8)
  + '\n\n— Decision made by the team: defer the next sprint planning until after the holidays.\n'
  + '— Tudor Mareș will lead the Q1 outreach refresh.\n'  // ← "Tudor" past char 500
  + '— Sorina Dobrescu confirmed availability for the panel.';

// Multi-language fixture for cross-script tests.
export const MULTILANG = `# International collaborators
Tudor (Romania), Александр (Russia), 渡辺 (Japan), José (Spain), محمد (Egypt).
All confirmed for the 2026 summit. Lead organizer: Tudor Mareș.`;

// Sensitive fixture variations for tier-gating.
export const SENSITIVE_FINANCIAL = `# Bank account placeholder
Account number 1234-5678-9012-3456. PIN: 0000. This is test data, do not use.`;
