import { FONT } from './led-font.js';

export const MATRIX_COLUMNS = 32;
export const MATRIX_ROWS = 7;

// The server owns normalization. Unsupported code points each become one '?'.
export function textColumns(text) {
  const glyphs = Array.from(text, character => {
    const code = character.codePointAt(0);
    return FONT[(code >= 32 && code <= 126 ? code : 63) - 32];
  });
  const width = glyphs.reduce((total, glyph) => total + glyph.length, 0)
    + Math.max(0, glyphs.length - 1);
  const columns = new Uint8Array(width);
  let offset = 0;
  for (const glyph of glyphs) {
    columns.set(glyph, offset);
    offset += glyph.length + 1;
  }
  return columns;
}

// Signed integer offsets select a fixed viewport; negative values enter from the right.
// Bit 0 is the top row; clip font data to the visible rows without wrapping or scaling.
export function frameColumns(columns, offset = 0) {
  if (!Number.isInteger(offset)) throw new RangeError('Frame offset must be an integer');
  const frame = new Uint8Array(MATRIX_COLUMNS);
  for (let x = 0; x < MATRIX_COLUMNS; x++) {
    const source = x + offset;
    if (source >= 0 && source < columns.length) frame[x] = columns[source] & ((1 << MATRIX_ROWS) - 1);
  }
  return frame;
}
