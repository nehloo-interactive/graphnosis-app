/**
 * Agempus avatars — 43 hat shapes × ten colorways.
 *
 * NOTE when adding a shape: `defaultShapeFor` is `hash(seed) % SHAPES.length`,
 * so changing the length of the array re-rolls the default hat of every agent
 * that has never had its avatar edited. That is a one-time cosmetic shift, not
 * a data change — an explicit `record.shape` always wins — but it is visible,
 * so append deliberately rather than incidentally.
 *
 * An Agempus is a skill-template engram (see `rosterGraphIds` in agents.ts), and
 * the Agents grid renders each one as a round avatar wearing a hat. The hats are
 * inline SVG strings rather than image files on purpose:
 *
 *   - no bundler/asset-path config, and no broken-image state to design for;
 *   - they can be RECOLORED at render time, which is what lets shape and color
 *     be independent — ten of each gives a hundred distinct avatars instead of
 *     ten fixed ones;
 *   - an unknown shape or color id degrades to a deterministic default rather
 *     than leaving a hole in the grid.
 *
 * Shapes are drawn in a 64×64 box on an implicit circular plate, flat, with no
 * gradients or filters, so they stay crisp at both the 96px grid size and the
 * 40px sidebar size. Bodies never hard-code their own hue: they use the tokens
 * below, and `paint()` substitutes them.
 *
 *   {{C}}   main hat color
 *   {{C2}}  darker shade of it — bands, undersides, shadow
 *   {{INK}} outline ink, constant across colorways
 *   {{GOLD}} metallic accent (tassel, badge) — constant, reads on every hue
 */

const INK = '#1d2433';
const GOLD = '#f0b429';
/** Medical red. Fixed across colorways — a cross in the hat's own hue stops
 *  reading as medical, which is the entire point of that shape. */
const RED = '#e03131';

export interface AgempusHatShape {
  /** Stable id persisted in engram metadata. Never renumber these. */
  id: string;
  name: string;
  /** SVG body using the {{C}} / {{C2}} / {{INK}} / {{GOLD}} tokens. */
  body: string;
  /**
   * Section heading, set on the FIRST shape of each run only — the picker
   * carries the last one forward. At 43 shapes in a 148px scroller the flat
   * grid stopped being browsable: you could not find a specific hat without
   * hovering swatches one at a time to read their titles.
   */
  group?: string;
}

export interface AgempusColor {
  id: string;
  name: string;
  /** Main hue. */
  main: string;
  /** Darker shade for bands and undersides. */
  dark: string;
  /** Light tint for the round plate behind the figure — keeps each avatar
   *  internally coherent rather than pairing a random hat with a random plate. */
  plate: string;
}

export const AGEMPUS_HAT_SHAPES: AgempusHatShape[] = [
  {
    id: 'top-hat',
    name: 'Top hat',
    group: 'Everyday',
    body: `<rect x="22" y="13" width="20" height="23" rx="2" fill="{{C}}"/>
           <rect x="22" y="27" width="20" height="5" fill="{{C2}}"/>
           <rect x="13" y="35" width="38" height="5" rx="2.5" fill="{{C2}}"/>`,
  },
  {
    id: 'chef',
    name: 'Chef',
    body: `<path d="M20 30c-5 0-8-4-8-8s4-7 8-6c1-4 5-6 8-6s7 2 8 6c4-1 8 2 8 6s-3 8-8 8z" fill="{{C}}" stroke="{{INK}}" stroke-width="2" stroke-linejoin="round"/>
           <rect x="20" y="29" width="24" height="10" rx="1.5" fill="{{C2}}" stroke="{{INK}}" stroke-width="2"/>`,
  },
  {
    id: 'graduate',
    name: 'Graduate',
    body: `<path d="M32 13 7 24l25 11 25-11z" fill="{{C}}"/>
           <path d="M18 30v8c0 3 6 5 14 5s14-2 14-5v-8" fill="none" stroke="{{C2}}" stroke-width="4" stroke-linecap="round"/>
           <path d="M53 26v12" stroke="{{GOLD}}" stroke-width="2.5" stroke-linecap="round"/>
           <circle cx="53" cy="40" r="3.2" fill="{{GOLD}}"/>`,
  },
  {
    id: 'hard-hat',
    name: 'Hard hat',
    body: `<path d="M15 35c0-11 7-18 17-18s17 7 17 18z" fill="{{C}}" stroke="{{INK}}" stroke-width="2" stroke-linejoin="round"/>
           <path d="M28 18h8v17h-8z" fill="{{C2}}"/>
           <rect x="9" y="34" width="46" height="5.5" rx="2.75" fill="{{C}}" stroke="{{INK}}" stroke-width="2"/>`,
  },
  {
    id: 'beret',
    name: 'Beret',
    body: `<path d="M15 34c0-10 7-17 17-17s17 7 17 17z" fill="{{C}}"/>
           <circle cx="32" cy="15" r="3.2" fill="{{C2}}"/>
           <rect x="14" y="33" width="36" height="5" rx="2.5" fill="{{C2}}"/>`,
  },
  {
    id: 'crown',
    name: 'Crown',
    body: `<path d="M13 36 11 17l11 8 10-12 10 12 11-8-2 19z" fill="{{C}}" stroke="{{INK}}" stroke-width="2" stroke-linejoin="round"/>
           <rect x="13" y="36" width="38" height="5.5" rx="1.5" fill="{{C2}}" stroke="{{INK}}" stroke-width="2"/>
           <circle cx="32" cy="29" r="2.6" fill="{{GOLD}}"/>`,
  },
  {
    id: 'wizard',
    name: 'Wizard',
    body: `<path d="M32 6 19 36h26z" fill="{{C}}"/>
           <path d="M19 36h26l4 4H15z" fill="{{C2}}"/>
           <circle cx="29" cy="23" r="2.1" fill="{{GOLD}}"/>
           <circle cx="35" cy="31" r="1.6" fill="{{GOLD}}"/>`,
  },
  {
    id: 'cowboy',
    name: 'Cowboy',
    body: `<path d="M21 34c0-10 4-17 11-17s11 7 11 17z" fill="{{C}}"/>
           <path d="M7 35c6-3 11 2 25 2s19-5 25-2c0 4-11 7-25 7S7 39 7 35z" fill="{{C2}}"/>
           <rect x="21" y="29" width="22" height="4.5" fill="{{C2}}"/>`,
  },
  {
    id: 'party',
    name: 'Party',
    body: `<path d="M32 8 20 37h24z" fill="{{C}}"/>
           <path d="M24 25h16M21.5 32h21" stroke="{{C2}}" stroke-width="2.8" stroke-linecap="round"/>
           <circle cx="32" cy="7" r="3.6" fill="{{GOLD}}"/>`,
  },
  {
    id: 'captain',
    name: 'Captain',
    body: `<path d="M18 29c0-8 6-13 14-13s14 5 14 13z" fill="{{C}}" stroke="{{INK}}" stroke-width="2" stroke-linejoin="round"/>
           <rect x="17" y="28" width="30" height="6" fill="{{C2}}"/>
           <path d="M11 35h42l-4 5.5H15z" fill="{{C2}}"/>
           <circle cx="32" cy="24" r="3" fill="{{GOLD}}"/>`,
  },
  // ── Job families ─────────────────────────────────────────────────────────
  {
    id: 'nurse',
    name: 'Nurse',
    group: 'On the job',
    body: `<path d="M19 35 24 21h16l5 14z" fill="{{C}}" stroke="{{INK}}" stroke-width="2" stroke-linejoin="round"/>
           <path d="M30 24h4v9h-4z" fill="${RED}"/>
           <path d="M27.5 26.5h9v4h-9z" fill="${RED}"/>`,
  },
  {
    id: 'surgeon',
    name: 'Surgeon',
    body: `<path d="M17 33c0-9 7-15 15-15s15 6 15 15z" fill="{{C}}"/>
           <rect x="16" y="32" width="32" height="4.5" rx="2.25" fill="{{C2}}"/>
           <path d="M48 34l7 3-7 2.5z" fill="{{C2}}"/>`,
  },
  {
    id: 'police',
    name: 'Police',
    body: `<path d="M19 27c0-7 6-11 13-11s13 4 13 11z" fill="{{C}}"/>
           <rect x="17" y="26" width="30" height="6" rx="1" fill="{{C2}}"/>
           <path d="M11 32h42l-4 5.5H15z" fill="{{INK}}"/>
           <path d="M32 18l3.4 5.6h-6.8z" fill="{{GOLD}}"/>`,
  },
  {
    id: 'firefighter',
    name: 'Firefighter',
    body: `<path d="M19 32c0-9 6-15 13-15s13 6 13 15z" fill="{{C}}"/>
           <path d="M32 17v15" stroke="{{C2}}" stroke-width="3"/>
           <path d="M7 36c4-4 13-3 25-3s21-1 25 3c-4 4-14 5.5-25 5.5S11 40 7 36z" fill="{{C2}}"/>`,
  },
  {
    id: 'pilot',
    name: 'Pilot',
    body: `<path d="M19 27c0-7 6-11 13-11s13 4 13 11z" fill="{{C}}"/>
           <rect x="17" y="26" width="30" height="6" rx="1" fill="{{C2}}"/>
           <path d="M11 32h42l-4 5.5H15z" fill="{{C2}}"/>
           <path d="M20 29l12-2.4L44 29l-12 2.4z" fill="{{GOLD}}"/>`,
  },
  {
    id: 'detective',
    name: 'Detective',
    body: `<circle cx="14" cy="30" r="5.5" fill="{{C2}}"/>
           <circle cx="50" cy="30" r="5.5" fill="{{C2}}"/>
           <path d="M20 32c0-9 5-15 12-15s12 6 12 15z" fill="{{C}}"/>
           <rect x="9" y="32" width="46" height="4.5" rx="2.25" fill="{{C2}}"/>`,
  },
  {
    id: 'baseball-cap',
    name: 'Ball cap',
    body: `<path d="M18 33c0-9 6-15 14-15s14 6 14 15z" fill="{{C}}"/>
           <path d="M44 32c8 .4 12 2.4 12 5H44z" fill="{{C2}}"/>
           <circle cx="32" cy="19" r="2.2" fill="{{C2}}"/>`,
  },
  {
    id: 'beanie',
    name: 'Beanie',
    body: `<path d="M19 33c0-9 6-15 13-15s13 6 13 15z" fill="{{C}}"/>
           <rect x="17" y="32" width="30" height="7" rx="3.5" fill="{{C2}}"/>
           <circle cx="32" cy="14" r="4.2" fill="{{C2}}"/>`,
  },
  {
    id: 'farmer',
    name: 'Farmer',
    body: `<path d="M22 33c0-8 4-13 10-13s10 5 10 13z" fill="{{C}}"/>
           <ellipse cx="32" cy="35.5" rx="24" ry="5.2" fill="{{C2}}"/>
           <rect x="22" y="29.5" width="20" height="3.5" fill="{{INK}}" opacity=".3"/>`,
  },
  {
    id: 'explorer',
    name: 'Explorer',
    body: `<path d="M17 33c0-10 7-16 15-16s15 6 15 16z" fill="{{C}}"/>
           <ellipse cx="32" cy="34.5" rx="21" ry="5" fill="{{C2}}"/>
           <path d="M32 17v16" stroke="{{C2}}" stroke-width="2"/>`,
  },
  {
    id: 'judge',
    name: 'Judge',
    body: `<path d="M18 30c0-8 6-14 14-14s14 6 14 14v6c0 3-2.5 5-5.5 5H23.5c-3 0-5.5-2-5.5-5z" fill="{{C}}"/>
           <path d="M20 26h24M20 32h24" stroke="{{C2}}" stroke-width="2.2"/>`,
  },
  {
    id: 'flat-cap',
    name: 'Flat cap',
    body: `<path d="M20 32c0-8 5-13 12-13s12 5 12 13z" fill="{{C}}"/>
           <path d="M18 31h30c4.5 0 6.5 2.2 6.5 4.5H18z" fill="{{C2}}"/>`,
  },
  // ── Worn around the world ────────────────────────────────────────────────
  // The first 22 shapes were all Western or occupational. These are everyday
  // and formal head coverings from elsewhere, drawn in the same flat grammar.
  //
  // Religious coverings are included deliberately: a dastar, a kippah and a
  // hijab are ordinary daily wear for millions of people, and leaving them out
  // while shipping a wizard hat would be the odd choice. They are named
  // correctly and drawn plainly, with no caricature of the wearer.
  //
  // What is deliberately NOT here: sacred or earned regalia worn as costume —
  // a Plains war bonnet is the clearest case, where each feather is conferred.
  // The test for adding a shape is whether someone from that culture would
  // recognise it as their hat rather than as a costume of themselves.
  {
    id: 'turban',
    name: 'Turban (dastar)',
    group: 'Around the world',
    body: `<path d="M16 36c0-11 7-19 16-19s16 8 16 19z" fill="{{C}}"/>
           <path d="M16.8 30.5c4.6-2.8 9.7-4.2 15.2-4.2s10.6 1.4 15.2 4.2" fill="none" stroke="{{C2}}" stroke-width="2.6" stroke-linecap="round"/>
           <path d="M19.5 24.2c3.9-2.6 8.3-3.9 12.5-3.9s8.6 1.3 12.5 3.9" fill="none" stroke="{{C2}}" stroke-width="2.3" stroke-linecap="round"/>
           <path d="M32 17c2.4 0 4.3 1.5 5 3.4-1.7-.9-3.3-1.4-5-1.4s-3.3.5-5 1.4c.7-1.9 2.6-3.4 5-3.4z" fill="{{C2}}"/>`,
  },
  {
    id: 'keffiyeh',
    name: 'Keffiyeh',
    body: `<path d="M16 45V31c0-8.5 7-15 16-15s16 6.5 16 15v14l-6-3.5V32c0-5.8-4.5-10-10-10s-10 4.2-10 10v9.5z" fill="{{C}}"/>
           <path d="M22 26.5c3-1.6 6.4-2.4 10-2.4s7 .8 10 2.4" fill="none" stroke="{{INK}}" stroke-width="2.6" stroke-linecap="round"/>
           <path d="M21.6 31c3.2-1.7 6.6-2.5 10.4-2.5s7.2.8 10.4 2.5" fill="none" stroke="{{INK}}" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  {
    id: 'tagelmust',
    name: 'Tagelmust',
    body: `<path d="M16 36c0-11 7-19 16-19s16 8 16 19z" fill="{{C}}"/>
           <path d="M17 29.5c4.6-2.8 9.6-4.2 15-4.2s10.4 1.4 15 4.2" fill="none" stroke="{{C2}}" stroke-width="2.4" stroke-linecap="round"/>
           <path d="M18 36h28v4.2c0 1.6-1.3 2.9-2.9 2.9H20.9c-1.6 0-2.9-1.3-2.9-2.9z" fill="{{C2}}"/>`,
  },
  {
    id: 'fez',
    name: 'Fez',
    body: `<path d="M23.5 36.5V21.5c0-1.7 3.8-2.8 8.5-2.8s8.5 1.1 8.5 2.8v15z" fill="{{C}}"/>
           <ellipse cx="32" cy="21.3" rx="8.5" ry="2.5" fill="{{C2}}"/>
           <path d="M32.5 21.2c.6 5.4 8 5.4 8.4 10.4" fill="none" stroke="{{GOLD}}" stroke-width="1.9" stroke-linecap="round"/>
           <circle cx="41" cy="34" r="2.7" fill="{{GOLD}}"/>`,
  },
  {
    id: 'conical',
    name: 'Conical hat',
    body: `<path d="M32 11 7.5 37.5h49z" fill="{{C}}"/>
           <ellipse cx="32" cy="37.5" rx="24.5" ry="3.2" fill="{{C2}}"/>
           <path d="M23.5 28h17M19 33h26" stroke="{{C2}}" stroke-width="1.6" stroke-linecap="round"/>`,
  },
  {
    id: 'ushanka',
    name: 'Ushanka',
    body: `<path d="M19 34c0-8 5.8-14 13-14s13 6 13 14z" fill="{{C}}"/>
           <path d="M19.5 22.5c-3.2-1.4-5.6-.4-6.2 1.9-.6 2.3.9 4.3 3.6 4.9l3.6.8z" fill="{{C2}}"/>
           <path d="M44.5 22.5c3.2-1.4 5.6-.4 6.2 1.9.6 2.3-.9 4.3-3.6 4.9l-3.6.8z" fill="{{C2}}"/>
           <rect x="16" y="32.5" width="32" height="7" rx="3.5" fill="{{C2}}"/>`,
  },
  {
    id: 'chullo',
    name: 'Chullo',
    body: `<path d="M20 34c0-8 5.4-14 12-14s12 6 12 14z" fill="{{C}}"/>
           <circle cx="32" cy="17.6" r="3.4" fill="{{C2}}"/>
           <path d="M20.5 33h5.2v8.4c0 1.6-1.2 2.7-2.6 2.7s-2.6-1.1-2.6-2.7z" fill="{{C2}}"/>
           <path d="M38.3 33h5.2v8.4c0 1.6-1.2 2.7-2.6 2.7s-2.6-1.1-2.6-2.7z" fill="{{C2}}"/>
           <path d="M21.5 28h21" stroke="{{C2}}" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  {
    id: 'gele',
    name: 'Gele',
    body: `<path d="M17 36c0-9 6.7-16 15-16s15 7 15 16z" fill="{{C}}"/>
           <path d="M44 22.5c4-4 9-4.7 11-2.3 2 2.4.4 6.5-4 9.5-2.6 1.8-5.4 2.8-7.6 3z" fill="{{C2}}"/>
           <path d="M19.5 30c3.9-2.6 8.1-3.9 12.5-3.9s8.6 1.3 12.5 3.9" fill="none" stroke="{{C2}}" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  {
    id: 'sombrero',
    name: 'Sombrero',
    body: `<path d="M22 33V22.5c0-3.4 4.5-5.7 10-5.7s10 2.3 10 5.7V33z" fill="{{C}}"/>
           <path d="M4 36c0-2.6 12.5-4.7 28-4.7S60 33.4 60 36c0 3-12.5 5.4-28 5.4S4 39 4 36z" fill="{{C}}"/>
           <path d="M4 36c0 3 12.5 5.4 28 5.4S60 39 60 36c0 1.7-12.5 3.5-28 3.5S4 37.7 4 36z" fill="{{C2}}"/>
           <path d="M22.5 28.5h19" stroke="{{C2}}" stroke-width="3"/>`,
  },
  {
    id: 'kufi',
    name: 'Kufi',
    body: `<path d="M20 35c0-7.4 5.4-12 12-12s12 4.6 12 12z" fill="{{C}}"/>
           <rect x="19.5" y="33.4" width="25" height="4.6" rx="2.3" fill="{{C2}}"/>
           <path d="M24.5 28.5h15" stroke="{{C2}}" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  {
    id: 'hijab',
    name: 'Hijab',
    body: `<path d="M32 14c-10.5 0-18 8-18 19 0 7 2 13 4.4 17l6.6-3.4c-1.6-3-2.4-7.6-2.4-12 0-6.8 5-11.8 11.4-11.8s11.4 5 11.4 11.8c0 4.4-.8 9-2.4 12l6.6 3.4c2.4-4 4.4-10 4.4-17 0-11-7.5-19-18-19z" fill="{{C}}"/>
           <path d="M23.2 24.4c2.6-2 5.6-3 8.8-3s6.2 1 8.8 3" fill="none" stroke="{{C2}}" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  {
    id: 'kippah',
    name: 'Kippah',
    body: `<path d="M23 33.6c0-5 4-8.7 9-8.7s9 3.7 9 8.7z" fill="{{C}}"/>
           <rect x="21.6" y="32.8" width="20.8" height="2.8" rx="1.4" fill="{{C2}}"/>`,
  },
  // ── Out of the history books ─────────────────────────────────────────────
  {
    id: 'nemes',
    name: 'Nemes',
    group: 'Through history',
    body: `<path d="M32 12c-9 0-15 6.4-15 15v6l-3 12h9l2-14c0-5.6 3-9 7-9s7 3.4 7 9l2 14h9l-3-12v-6c0-8.6-6-15-15-15z" fill="{{C}}"/>
           <path d="M19 27.5h5M40 27.5h5M18.6 33h5.4M40 33h5.4" stroke="{{C2}}" stroke-width="2.2" stroke-linecap="round"/>
           <path d="M32 12.6c2 0 3.5 1.6 3.5 3.6 0 1.4-.8 2.6-2 3.2h-3c-1.2-.6-2-1.8-2-3.2 0-2 1.5-3.6 3.5-3.6z" fill="{{GOLD}}"/>`,
  },
  {
    id: 'galea',
    name: 'Galea',
    body: `<path d="M20 37V29c0-6.8 5.4-12 12-12s12 5.2 12 12v8l-3.6-2.4V29c0-5-3.8-8.6-8.4-8.6S23.6 24 23.6 29v5.6z" fill="{{C}}" stroke="{{INK}}" stroke-width="1.8" stroke-linejoin="round"/>
           <path d="M13.5 22c1.5-7.5 9.5-13 18.5-13s17 5.5 18.5 13c-2.5-4.5-9.5-8-18.5-8s-16 3.5-18.5 8z" fill="{{C2}}"/>
           <circle cx="32" cy="26.5" r="2.4" fill="{{GOLD}}"/>`,
  },
  {
    id: 'kabuto',
    name: 'Kabuto',
    body: `<path d="M21 33c0-7 5-12 11-12s11 5 11 12z" fill="{{C}}"/>
           <path d="M12.5 40.5c0-5 4-8.4 9-9.4l1.2 4.2c-3 .8-5 2.8-5 5.2zM51.5 40.5c0-5-4-8.4-9-9.4l-1.2 4.2c3 .8 5 2.8 5 5.2z" fill="{{C2}}"/>
           <path d="M25.6 20.5c1.6-4.2 4-7 6.4-8.5 2.4 1.5 4.8 4.3 6.4 8.5-2-2-4.2-3-6.4-3s-4.4 1-6.4 3z" fill="{{GOLD}}"/>
           <rect x="19.5" y="31.4" width="25" height="4.6" rx="2.3" fill="{{C2}}"/>`,
  },
  {
    id: 'tricorne',
    name: 'Tricorne',
    body: `<path d="M32 15c-7 0-11 5-12.5 10L10 36c6-2 14-3 22-3s16 1 22 3l-9.5-11C43 20 39 15 32 15z" fill="{{C}}"/>
           <path d="M10 36c6-2 14-3 22-3s16 1 22 3c-5 3-13 4.6-22 4.6S15 39 10 36z" fill="{{C2}}"/>`,
  },
  {
    id: 'phrygian',
    name: 'Phrygian cap',
    body: `<path d="M19 36c0-9.4 5.8-16.4 13-16.4 4 0 7 2 8.6 4.8 2.4-1.6 5-1.4 6.4.6 1.6 2.2.4 5-2.6 6.4-2 1-4.2 1.2-6 .8.6 1.2 1 2.5 1 3.8z" fill="{{C}}"/>
           <rect x="18.5" y="34.6" width="27" height="4.6" rx="2.3" fill="{{C2}}"/>`,
  },
  {
    id: 'dacian',
    name: 'Dacian cap (pileus)',
    // The Burebista-era Dacian cap. It is a soft brimless pileus whose crown
    // folds over on TOP — deliberately drawn rounder and without the forward
    // hook of `phrygian` above, which is its close cousin and the shape it is
    // most often confused with.
    //
    // Worth knowing what it signified: only Dacian nobles wore it. Trajan's
    // Column shows the two classes distinctly — the capped *tarabostes*
    // (pileati, "cap-wearers") and the bare-headed *comati* ("the long-haired"
    // commoners). The cap WAS the rank.
    body: `<path d="M20 36.5c0-8.8 5.4-14.8 12-14.8s12 6 12 14.8z" fill="{{C}}"/>
           <path d="M24 26.6c-2.2-3.7-1-7.9 2.8-9.9 4-2.1 9.2-.9 11.8 2.7 1.7 2.4 1.6 5.2-.2 6.9-3.2 3-11.8 2.7-14.4.3z" fill="{{C2}}"/>
           <path d="M20.8 32.6c3.5-1.9 7.2-2.9 11.2-2.9s7.7 1 11.2 2.9" fill="none" stroke="{{C2}}" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  {
    id: 'viking',
    name: 'Viking helm',
    // NO horns. Horned Viking helmets are a 19th-century costume invention —
    // largely Wagner's Ring staging — and appear in exactly zero Norse graves.
    // The one helmet ever recovered whole (Gjermundbu, Norway) is this: a
    // riveted conical bowl with a brow band and a nasal guard. Named "Viking
    // helm" rather than "spangenhelm" so it is findable in the picker; drawn
    // as the real thing.
    body: `<path d="M20 36V30c0-7.4 5.2-13 12-13s12 5.6 12 13v6z" fill="{{C}}" stroke="{{INK}}" stroke-width="1.8" stroke-linejoin="round"/>
           <path d="M32 17.6V36" stroke="{{C2}}" stroke-width="2.2"/>
           <rect x="19" y="34" width="26" height="4.4" rx="1.4" fill="{{C2}}" stroke="{{INK}}" stroke-width="1.6"/>
           <path d="M30.4 38.4h3.2v7.4h-3.2z" fill="{{C2}}" stroke="{{INK}}" stroke-width="1.4" stroke-linejoin="round"/>`,
  },
  {
    id: 'hennin',
    name: 'Hennin',
    body: `<path d="M43.5 8.5c2.2 1.8 2.2 4.8 0 7.4L26 36.5h-8L38 10c2-2.6 3.4-3.2 5.5-1.5z" fill="{{C}}"/>
           <path d="M43.5 8.5c3.6 2.8 5 7.4 3.6 12-1.4 4.8-5.4 8.8-10.6 11l-2.6-4.6c3.8-1.6 6.6-4.4 7.6-7.8 1-3.2.4-6.4-1.6-8.6z" fill="{{C2}}"/>`,
  },
  {
    id: 'bearskin',
    name: 'Bearskin',
    body: `<path d="M21 37V21c0-5.6 4.6-9.6 11-9.6S43 15.4 43 21v16z" fill="{{C}}"/>
           <rect x="20.6" y="36" width="22.8" height="3" fill="{{C2}}"/>
           <path d="M25.5 39c1 3.6 3.4 5.6 6.5 5.6s5.5-2 6.5-5.6" fill="none" stroke="{{C2}}" stroke-width="2" stroke-linecap="round"/>
           <path d="M43 17.5c2 0 3.4 1.6 3.4 3.7s-1.4 3.7-3.4 3.7z" fill="{{GOLD}}"/>`,
  },
];

export const AGEMPUS_COLORS: AgempusColor[] = [
  { id: 'indigo',  name: 'Indigo',  main: '#4c6ef5', dark: '#3550c4', plate: '#dbe4ff' },
  { id: 'crimson', name: 'Crimson', main: '#e03131', dark: '#b02525', plate: '#ffe3e3' },
  { id: 'emerald', name: 'Emerald', main: '#2f9e44', dark: '#237a34', plate: '#d3f9d8' },
  { id: 'amber',   name: 'Amber',   main: '#f08c00', dark: '#c26f00', plate: '#ffec99' },
  { id: 'violet',  name: 'Violet',  main: '#7048e8', dark: '#5638b8', plate: '#e5dbff' },
  { id: 'teal',    name: 'Teal',    main: '#0ca678', dark: '#087f5b', plate: '#c3fae8' },
  { id: 'rose',    name: 'Rose',    main: '#e64980', dark: '#b83364', plate: '#ffdeeb' },
  // No grey in this palette, on purpose. `.agempus-tile.is-disabled` signals
  // OFF with `filter: grayscale(1)`, so a grey agent would look almost the
  // same on as off — the state and its own resting colour would collide, and
  // the collision would be worst on the one state that changes what the
  // product does. Plum replaced the old 'slate' for exactly this reason; every
  // remaining colorway is saturated enough that greyscale is unmistakable.
  { id: 'plum',    name: 'Plum',    main: '#9c36b5', dark: '#7a2a8f', plate: '#f3d9fa' },
  { id: 'cyan',    name: 'Cyan',    main: '#1098ad', dark: '#0b7285', plate: '#c5f6fa' },
  { id: 'sand',    name: 'Sand',    main: '#a9744f', dark: '#835739', plate: '#ffe8cc' },
];

/** Stable non-negative hash. Deliberately NOT Math.random: an avatar that
 *  changed on every render would read as a different agent each time. The
 *  assignment looks random across agents but is fixed for any given one, on
 *  every machine and across restarts. */
function hashSeed(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** Shape and color are hashed independently — a second, differently-mixed hash
 *  for color, so the two axes don't move in lockstep and produce only ten of
 *  the hundred possible combinations. */
export function defaultShapeFor(seed: string): string {
  return AGEMPUS_HAT_SHAPES[hashSeed(seed) % AGEMPUS_HAT_SHAPES.length]!.id;
}

export function defaultColorFor(seed: string): string {
  const mixed = hashSeed(`${seed}#colour`);
  return AGEMPUS_COLORS[mixed % AGEMPUS_COLORS.length]!.id;
}

export function shapeById(id: string | undefined | null): AgempusHatShape {
  // An unknown id (hand-edited metadata, or a shape retired in a later version)
  // must not blank the grid.
  return (id ? AGEMPUS_HAT_SHAPES.find((s) => s.id === id) : undefined) ?? AGEMPUS_HAT_SHAPES[0]!;
}

export function colorById(id: string | undefined | null): AgempusColor {
  return (id ? AGEMPUS_COLORS.find((c) => c.id === id) : undefined) ?? AGEMPUS_COLORS[0]!;
}

/** Substitute the color tokens in a shape body. */
function paint(body: string, c: AgempusColor): string {
  return body
    .replace(/\{\{C2\}\}/g, c.dark)
    .replace(/\{\{C\}\}/g, c.main)
    .replace(/\{\{INK\}\}/g, INK)
    .replace(/\{\{GOLD\}\}/g, GOLD);
}

export interface AvatarOptions {
  /** graphId — drives the deterministic defaults. */
  seed: string;
  /** Explicit shape id from metadata; falls back to the deterministic default. */
  shapeId?: string | undefined;
  /** Explicit color id from metadata; falls back to the deterministic default. */
  colorId?: string | undefined;
  /** Rendered pixel size. */
  size: number;
}

/**
 * One round avatar as an HTML string.
 *
 * Returns markup rather than a node so it drops into the existing
 * innerHTML-based renderers in skills.ts without restructuring them.
 */
export function renderAgempusAvatar(opts: AvatarOptions): string {
  const shape = shapeById(opts.shapeId ?? defaultShapeFor(opts.seed));
  const color = colorById(opts.colorId ?? defaultColorFor(opts.seed));
  const s = opts.size;
  return (
    `<span class="agempus-avatar" style="width:${s}px;height:${s}px;background:${color.plate};" aria-hidden="true">` +
    `<svg viewBox="0 0 64 64" width="${s}" height="${s}" role="img">` +
    // A neutral head under the hat, so the hat has something to sit on and the
    // avatar still reads as "someone" at 40px.
    `<circle cx="32" cy="45" r="11" fill="#ffffff" opacity="0.92"/>` +
    `<path d="M14 64c0-9 8-14 18-14s18 5 18 14z" fill="#ffffff" opacity="0.92"/>` +
    paint(shape.body, color) +
    `</svg></span>`
  );
}

/** Shape grid for the avatar-edit popover — each swatch in the agent's current
 *  color, so the choice being made is shape alone. */
export function renderShapePicker(seed: string, selectedShape: string, colorId: string): string {
  return AGEMPUS_HAT_SHAPES.map((s) => (
    (s.group ? `<span class="agempus-pick-group">${s.group}</span>` : '') +
    `<button type="button" class="agempus-pick agempus-pick-shape${s.id === selectedShape ? ' is-selected' : ''}"` +
    ` data-shape-id="${s.id}" title="${s.name}" aria-label="${s.name}" aria-pressed="${s.id === selectedShape}">` +
    renderAgempusAvatar({ seed, shapeId: s.id, colorId, size: 40 }) +
    `</button>`
  )).join('');
}

/** Color row for the popover — each swatch in the agent's current shape. */
export function renderColorPicker(seed: string, shapeId: string, selectedColor: string): string {
  return AGEMPUS_COLORS.map((c) => (
    `<button type="button" class="agempus-pick agempus-pick-color${c.id === selectedColor ? ' is-selected' : ''}"` +
    ` data-color-id="${c.id}" title="${c.name}" aria-label="${c.name}" aria-pressed="${c.id === selectedColor}">` +
    `<span class="agempus-swatch" style="background:${c.main};"></span>` +
    `</button>`
  )).join('');
}
