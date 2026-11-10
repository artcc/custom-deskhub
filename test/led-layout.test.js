const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const loader = Promise.all(['led-font.js', 'led-layout.js'].map(file =>
  fs.readFile(path.join(root, 'public', file), 'utf8')
)).then(async ([font, layout]) => {
  const fontUrl = moduleUrl(font);
  return {
    ...await import(fontUrl),
    ...await import(moduleUrl(layout.replace('./led-font.js', fontUrl)))
  };
});

function pixelRows(columns) {
  return Array.from({ length: 8 }, (_, row) =>
    Array.from(columns, column => column & (1 << row) ? '#' : '.').join('')
  );
}

test('the new MD_MAX72XX font covers all 95 printable ASCII characters', async () => {
  const { FONT, textColumns } = await loader;
  assert.equal(FONT.length, 95);
  for (let code = 32; code <= 126; code++) {
    const glyph = FONT[code - 32];
    assert.ok(Array.isArray(glyph) && glyph.length > 0, `ASCII ${code}`);
    assert.ok(glyph.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
    assert.deepEqual(textColumns(String.fromCodePoint(code)), Uint8Array.from(glyph));
    if (code > 32) assert.ok(glyph.some(Boolean), `ASCII ${code} must not be blank`);
  }
  assert.deepEqual([' ', 'H', 'e', 'l', 'o'].map(character => textColumns(character).length), [2, 5, 4, 1, 4]);
  assert.deepEqual(Array.from(textColumns('1')), [4, 2, 127]);
  assert.deepEqual(Array.from(textColumns('7')), [3, 1, 1, 1, 127]);
});

test('Hello has the 19-column new-font silhouette with bit zero at the top', async () => {
  const { textColumns } = await loader;
  const columns = textColumns('Hello');
  assert.equal(columns.length, 19);
  assert.deepEqual(pixelRows(columns), [
    '#...#......#.#.....',
    '#...#......#.#.....',
    '#...#..##..#.#..##.',
    '#####.#..#.#.#.#..#',
    '#...#.####.#.#.#..#',
    '#...#.#....#.#.#..#',
    '#...#..###.#.#..##.',
    '...................'
  ]);
});

test('lowercase ascenders and eighth-row descenders retain their distinct shapes', async () => {
  const { textColumns } = await loader;
  assert.deepEqual(pixelRows(textColumns('b')), ['#...', '#...', '###.', '#..#', '#..#', '#..#', '###.', '....']);
  const descenders = { g: '.##.', j: '##.', p: '#...', q: '...#', y: '.##.' };
  for (const [character, bottom] of Object.entries(descenders)) {
    assert.equal(pixelRows(textColumns(character))[7], bottom, character);
  }
  assert.equal(pixelRows(textColumns('e'))[0], '....');
  assert.equal(pixelRows(textColumns('l'))[0], '#');
});

test('punctuation preserves the eighth row and narrow glyphs', async () => {
  const { textColumns } = await loader;
  assert.deepEqual(pixelRows(textColumns('$')), ['..#..', '.####', '#.#..', '.###.', '..#.#', '..#.#', '####.', '..#..']);
  assert.deepEqual(Array.from(textColumns('_,;!')), [128, 128, 128, 128, 0, 96, 224, 0, 108, 236, 0, 95]);
  assert.deepEqual(Array.from(textColumns('\'"')), [7, 0, 7, 0, 7]);
});

test('spacing adds exactly one blank column between glyphs and preserves explicit spaces', async () => {
  const { textColumns } = await loader;
  assert.deepEqual(Array.from(textColumns('ll')), [127, 0, 127]);
  assert.deepEqual(Array.from(textColumns(' l ')), [0, 0, 0, 127, 0, 0, 0]);
  assert.deepEqual(Array.from(textColumns('l  ')), [127, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(textColumns('  ')), [0, 0, 0, 0, 0]);
});

test('unsupported code points use one question mark each without client normalization', async () => {
  const { textColumns } = await loader;
  assert.deepEqual(textColumns('é😀\n\u007f'), textColumns('????'));
  assert.deepEqual(textColumns('e\u0301'), textColumns('e?'));
  assert.notDeepEqual(textColumns('é'), textColumns('e'));
});

test('a frame is exactly 32 by 7, left aligned, with no fitting or wrapping', async () => {
  const { MATRIX_COLUMNS, MATRIX_ROWS, textColumns, frameColumns } = await loader;
  assert.equal(MATRIX_COLUMNS, 32);
  assert.equal(MATRIX_ROWS, 7);
  const overflow = textColumns('MMMMMll');
  assert.equal(overflow.length, 33);
  assert.deepEqual(frameColumns(overflow), overflow.slice(0, 32));
  assert.equal(frameColumns(overflow)[31], 0);
  assert.equal(frameColumns(overflow, 1)[31], 127);
  const boundary = textColumns('MMMMM.');
  assert.equal(boundary.length, 32);
  assert.deepEqual(frameColumns(boundary), boundary);
  const short = frameColumns(textColumns('l'));
  assert.deepEqual(short, Uint8Array.from([127, ...Array(31).fill(0)]));
  assert.deepEqual(pixelRows(short)[7], '.'.repeat(32));
  const descenders = textColumns('gjpqy_$');
  assert.ok(descenders.some(column => column & 128));
  const clipped = frameColumns(descenders);
  assert.ok(clipped.every(column => column <= 127));
  assert.deepEqual(pixelRows(clipped).slice(0, 7), pixelRows(descenders.slice(0, 32)).slice(0, 7));
});

test('signed offsets enter from the right and exit left without recycling pixels', async () => {
  const { frameColumns } = await loader;
  const columns = Uint8Array.from([1, 2, 4]);
  assert.deepEqual(frameColumns(columns, -32), new Uint8Array(32));
  assert.deepEqual(frameColumns(columns, -31), Uint8Array.from([...Array(31).fill(0), 1]));
  assert.deepEqual(frameColumns(columns, -30), Uint8Array.from([...Array(30).fill(0), 1, 2]));
  assert.deepEqual(frameColumns(columns, 1), Uint8Array.from([2, 4, ...Array(30).fill(0)]));
  assert.deepEqual(frameColumns(columns, 2), Uint8Array.from([4, ...Array(31).fill(0)]));
  for (const offset of [-100, 3, 100]) assert.deepEqual(frameColumns(columns, offset), new Uint8Array(32));
  assert.deepEqual(columns, Uint8Array.from([1, 2, 4]));
});

test('long text retains every column and can scroll through the final glyph', async () => {
  const { textColumns, frameColumns } = await loader;
  const columns = textColumns('M'.repeat(2048) + '!');
  assert.equal(columns.length, 2048 * 6 + 1);
  assert.deepEqual(Array.from(columns.slice(-7)), [127, 2, 12, 2, 127, 0, 95]);
  assert.deepEqual(frameColumns(columns, columns.length - 1), Uint8Array.from([95, ...Array(31).fill(0)]));
  assert.deepEqual(frameColumns(columns, columns.length), new Uint8Array(32));
});

test('empty text and blank spaces produce black frames at every offset', async () => {
  const { textColumns, frameColumns } = await loader;
  assert.deepEqual(textColumns(''), new Uint8Array(0));
  for (const text of ['', ' ', '   ']) {
    for (const offset of [-32, -1, 0, 1, 32]) {
      assert.deepEqual(frameColumns(textColumns(text), offset), new Uint8Array(32));
    }
  }
});

test('fractional and nonnumeric offsets are rejected instead of silently blanking pixels', async () => {
  const { frameColumns } = await loader;
  for (const offset of [0.5, NaN, Infinity, '1', null]) {
    assert.throws(() => frameColumns(Uint8Array.of(1), offset), /offset must be an integer/);
  }
});
