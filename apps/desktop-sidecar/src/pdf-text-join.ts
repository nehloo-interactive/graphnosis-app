/**
 * Position-aware text joiner for pdfjs / unpdf `getTextContent()` output.
 *
 * Why this exists
 * ───────────────
 * The naive `items.map(it => it.str).join(' ')` we used to ship inserted
 * a literal space between every text run. For PDFs whose layout engine
 * emits ONE ITEM PER GLYPH (common with InDesign + custom font subsets,
 * including the Romanian "Din Vremuri De Departe" PDF that surfaced this
 * bug), that produced text like:
 *
 *     "dac ă vreodat ă î ţ i vei aminti ş i acest cântec"
 *                                                            ↑
 *   instead of:                                              user-visible
 *
 *     "dacă vreodată îți vei aminti și acest cântec"
 *
 * The join logic now reads each item's geometry to decide whether the
 * next item is:
 *   - touching the previous (no whitespace separator)
 *   - on the same line with a real gap (single space)
 *   - on a new line (newline)
 *
 * It then runs a final `.normalize('NFC')` pass so decomposed Unicode
 * (`a` + combining breve) becomes the precomposed character (`ă`).
 * pdfjs sometimes returns NFD for fonts whose ToUnicode CMap encodes
 * accents separately — the App's downstream consumers (search, embedding,
 * UI render) all expect NFC.
 *
 * Heuristics
 * ──────────
 * pdfjs `transform` is a 6-element matrix [a, b, c, d, e, f] where (e, f)
 * is the translation in user-space units. Item `width` is also in
 * user-space units (already scaled by the matrix). So:
 *
 *   prevRight = transformPrev.e + widthPrev
 *   currLeft  = transformCurr.e
 *   gap       = currLeft - prevRight
 *
 * If `gap` is meaningfully positive → real whitespace. If `gap` is
 * near zero or negative (overlap) → same word, no space. The threshold
 * of 1 unit was tuned against the failing Romanian PDF and standard
 * test PDFs — small enough to not insert spurious spaces inside
 * tightly-kerned text, large enough to catch genuine inter-word spacing.
 *
 * Line-break detection uses the `hasEOL` flag when present (pdfjs sets
 * this for newline runs) and falls back to a Y-coordinate change of >1
 * unit. EOL items have empty `str` so they don't add visible text.
 */

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}

const SAME_LINE_Y_TOLERANCE = 1.0;  // user-space units
const SPACE_GAP_THRESHOLD   = 1.0;  // ≥ this gap inserts a single space

export function joinPdfTextItems(rawItems: unknown[]): string {
  const items = rawItems as PdfTextItem[];
  let out = '';
  let prevRight: number | null = null;
  let prevY: number | null = null;

  for (const it of items) {
    if (it.hasEOL) {
      // pdfjs emits these for newline runs. Mark a line break and clear
      // positional tracking — the next visible item starts fresh on the
      // following line.
      if (!out.endsWith('\n')) out += '\n';
      prevRight = null;
      prevY = null;
      continue;
    }
    if (it.str == null || it.str === '') continue;

    const transform = it.transform ?? [1, 0, 0, 1, 0, 0];
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const width = typeof it.width === 'number' ? it.width : 0;
    const left = x;
    const right = x + width;

    if (prevRight !== null && prevY !== null) {
      if (Math.abs(y - prevY) > SAME_LINE_Y_TOLERANCE) {
        // Y shifted — new line.
        if (!out.endsWith('\n')) out += '\n';
      } else {
        const gap = left - prevRight;
        if (gap >= SPACE_GAP_THRESHOLD) {
          // Genuine whitespace between this item and the previous. Don't
          // double-space if the item itself starts with whitespace or
          // we just emitted one.
          if (!out.endsWith(' ') && !out.endsWith('\n') && !it.str.startsWith(' ')) {
            out += ' ';
          }
        }
        // gap < threshold (or negative): items are adjacent or kerned
        // together — concatenate directly with no separator.
      }
    }

    out += it.str;
    prevRight = right;
    prevY = y;
  }

  // NFC normalisation — collapse decomposed sequences like "a" + U+0306
  // into the precomposed character "ă". Idempotent; cheap.
  return out.normalize('NFC');
}
