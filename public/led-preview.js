import { MATRIX_COLUMNS, MATRIX_ROWS, textColumns, frameColumns } from './led-layout.js';

export function createLedPreview({ t }) {
  const svg = document.getElementById('led-matrix');
  const play = document.getElementById('led-play');
  const reset = document.getElementById('led-reset');
  const position = document.getElementById('led-position');
  const measurement = document.getElementById('led-measurement');
  const cells = [];
  const fragment = document.createDocumentFragment();
  for (let y = 0; y < MATRIX_ROWS; y += 1) {
    for (let x = 0; x < MATRIX_COLUMNS; x += 1) {
      const cell = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({ x: x * 10 + 1, y: y * 10 + 1, width: 8, height: 8, rx: 1 })) {
        cell.setAttribute(key, value);
      }
      cell.classList.add('led-cell');
      fragment.appendChild(cell);
      cells.push(cell);
    }
  }
  svg.appendChild(fragment);

  let columns = new Uint8Array();
  let offset = 0;
  let ready = false;
  let active = true;
  let timer = null;

  function draw() {
    const frame = frameColumns(columns, offset);
    for (let y = 0; y < MATRIX_ROWS; y += 1) {
      for (let x = 0; x < MATRIX_COLUMNS; x += 1) {
        cells[y * MATRIX_COLUMNS + x].classList.toggle('lit', Boolean(frame[x] & (1 << y)));
      }
    }
    position.value = offset;
    position.setAttribute('aria-valuetext', t('ledPositionValue', { column: offset }));
  }

  function controls() {
    play.disabled = reset.disabled = position.disabled = !ready || columns.length === 0;
    play.textContent = t(timer === null ? 'ledPlay' : 'ledPause');
    play.setAttribute('aria-pressed', String(timer !== null));
  }

  function pause() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    controls();
  }

  function setText(text) {
    pause();
    ready = true;
    columns = textColumns(text);
    offset = 0;
    position.min = columns.length ? -MATRIX_COLUMNS : 0;
    position.max = columns.length;
    measurement.textContent = t(columns.length > MATRIX_COLUMNS ? 'ledOverflows' : 'ledFits', {
      columns: columns.length, extra: columns.length - MATRIX_COLUMNS
    });
    measurement.classList.toggle('overflow', columns.length > MATRIX_COLUMNS);
    controls();
    draw();
  }

  function clear() {
    setText('');
    ready = false;
    measurement.textContent = t('ledWaiting');
    controls();
  }

  play.addEventListener('click', () => {
    if (timer !== null) return pause();
    if (!ready || !columns.length || !active || document.hidden) return;
    // Explicit playback only; speed and entry/exit are a simulation, not firmware settings.
    if (offset >= columns.length) offset = -MATRIX_COLUMNS;
    timer = window.setInterval(() => {
      offset = offset >= columns.length ? -MATRIX_COLUMNS : offset + 1;
      draw();
    }, 80);
    controls();
  });
  reset.addEventListener('click', () => {
    pause();
    offset = 0;
    draw();
  });
  position.addEventListener('input', () => {
    pause();
    offset = Number(position.value);
    draw();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  const observer = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) pause();
  });
  observer.observe(svg);
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', pause);

  clear();
  return {
    setText,
    clear,
    setActive(value) {
      active = value;
      if (!active) pause();
    }
  };
}
