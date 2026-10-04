// sp1device.js — the SP-1 drawing: outline, four faders, nine buttons, LEDs.
//
// Ported from the Sp1Device component of feldd.com's configurator
// (https://feldd.com/sp-1/configure, production build of 2026-10-03). Same
// geometry and the same visual vocabulary; plain DOM instead of React. Colours come from CSS custom properties: --accent, --ink, --dim, and
// --font-mono.
//
//   const dev = createSp1Device(el, { onSelect: ({kind, ix}) => ... });
//   dev.update({ monitor, selected, modeLeds, trackLeds, pressed, labels, reserved });
//
// monitor:   { f0..f3: 0..127, b0..b8: 0|1 }   (the device's `mon` events)
// selected:  { kind: 'fader'|'button', ix } | null
// modeLeds, trackLeds: arrays of 4 booleans, or null to hide the row
// pressed:   ['b3', 'func', ...] — pulsing overlays
// labels:    { F1: 'cutoff', Play: '...', ... } — tooltips
// reserved:  ['b0', ...] — buttons drawn dimmed and not selectable

const NS = 'http://www.w3.org/2000/svg';

// Fader column centres, shared by the fader slots and the track LEDs/buttons.
const FADER_X = [28.02, 64.67, 101.32, 137.98];
const trackRect = (x) => ({ x: x - 6.5, y: 202.5, w: 13, h: 29.5, rx: 2 });

export const BUTTONS = [
  { ix: 0, label: 'PLAY', name: 'Play',    id: 'Play', rect: { x: 169.5, y: 43, w: 14.5, h: 13, rx: 1.5 }, lab: { x: 166.5, y: 51.5, anchor: 'end' } },
  { ix: 1, label: 'T1',   name: 'Track 1', id: 'T1',   rect: trackRect(FADER_X[0]), lab: { x: FADER_X[0], y: 241, anchor: 'middle' } },
  { ix: 2, label: 'T2',   name: 'Track 2', id: 'T2',   rect: trackRect(FADER_X[1]), lab: { x: FADER_X[1], y: 241, anchor: 'middle' } },
  { ix: 3, label: 'T3',   name: 'Track 3', id: 'T3',   rect: trackRect(FADER_X[2]), lab: { x: FADER_X[2], y: 241, anchor: 'middle' } },
  { ix: 4, label: 'T4',   name: 'Track 4', id: 'T4',   rect: trackRect(FADER_X[3]), lab: { x: FADER_X[3], y: 241, anchor: 'middle' } },
  { ix: 5, label: 'VOL+', name: 'Vol +',   id: 'Vol+', rect: { x: 53, y: -1.5, w: 22.5, h: 10, rx: 1.5 }, lab: { x: 64.3, y: 16, anchor: 'middle' } },
  { ix: 6, label: 'VOL−', name: 'Vol -',   id: 'Vol-', rect: { x: 22, y: -1.5, w: 22.5, h: 10, rx: 1.5 }, lab: { x: 33.3, y: 16, anchor: 'middle' } },
  { ix: 7, label: 'FWD',  name: 'Forward', id: 'FWD',  rect: { x: 0, y: 40, w: 12, h: 9.9, rx: 1.5 }, lab: { x: 14, y: 46.5, anchor: 'start' } },
  { ix: 8, label: 'RWD',  name: 'Rewind',  id: 'RWD',  rect: { x: 0, y: 49.9, w: 12, h: 9.7, rx: 1.5 }, lab: { x: 14, y: 57, anchor: 'start' } },
];

const OUTLINE = `
<path d="M5.8963,59.56078c-.05469,0-.1084-.00684-.16309-.02051l-3.19336-.19434C1.00665,58.96312-.00019,57.66624-.00019,56.17894v-12.47559c0-1.4873,1.00684-2.78418,2.44824-3.15234l3.37695-.22461c.1084-.03418.30957.00684.46875.13086.16016.125.25195.3125.25195.51465h-1c0,.10645.05078.20996.13477.27539.05078.03906.11133.06348.1748.07129l-3.25098.21582c-.90723.24023-1.60449,1.13867-1.60449,2.16895v12.47559c0,1.03027.69727,1.92871,1.69629,2.18359l3.16406.19238c-.04199.00586-.11816.03125-.17969.0791-.08398.06543-.13477.16895-.13477.27539h1c0,.20215-.0918.38965-.25195.51465-.11523.08984-.25488.13672-.39746.13672Z"/>
<path d="M43.51349,5.14281h-20.38672V.65062C23.12677.29222,23.41876.00023,23.77813.00023h19.08398c.35938,0,.65137.29199.65137.65039v4.49219ZM24.12677,4.14281h18.38672V1.00023h-18.38672v3.14258Z"/>
<path d="M74.54864,5.14281h-20.38574V.65062C54.1629.29222,54.45489.00023,54.81329.00023h19.08496c.3584,0,.65039.29199.65039.65039v4.49219ZM55.1629,4.14281h18.38574V1.00023h-18.38574v3.14258Z"/>
<path d="M203.36212,239.83617h-12.62598v-44.66504h12.62598c.35938,0,.65137.29199.65137.65137v43.36328c0,.3584-.29199.65039-.65137.65039ZM191.73614,238.83617h11.27734v-42.66504h-11.27734v42.66504Z"/>
<path d="M203.36212,71.97289h-12.62598V27.30785h12.62598c.35938,0,.65137.29199.65137.65039v43.36328c0,.35938-.29199.65137-.65137.65137ZM191.73614,70.97289h11.27734V28.30785h-11.27734v42.66504Z"/>
<path d="M186.44317,263.86742h-25.09961V4.14281h25.09961c2.91895,0,5.29297,2.37402,5.29297,5.29199v249.14062c0,2.91797-2.37402,5.29199-5.29297,5.29199ZM162.34356,262.86742h24.09961c2.36719,0,4.29297-1.92578,4.29297-4.29199V9.4348c0-2.36621-1.92578-4.29199-4.29297-4.29199h-24.09961v257.72461Z"/>
<path d="M161.57403,263.86742H10.91681c-2.91797,0-5.29199-2.37402-5.29199-5.29199V9.4348c0-2.91797,2.37402-5.29199,5.29199-5.29199h150.65723v1H10.91681c-2.36621,0-4.29199,1.92578-4.29199,4.29199v249.14062c0,2.36621,1.92578,4.29199,4.29199,4.29199h150.65723v1Z"/>
<path d="M137.9754,159.23265c-2.80078,0-5.0791-2.27832-5.0791-5.07812v-41.20801c0-2.80078,2.27832-5.0791,5.0791-5.0791s5.0791,2.27832,5.0791,5.0791v41.20801c0,2.7998-2.27832,5.07812-5.0791,5.07812ZM137.9754,108.86742c-2.24902,0-4.0791,1.83008-4.0791,4.0791v41.20801c0,2.24902,1.83008,4.07812,4.0791,4.07812s4.0791-1.8291,4.0791-4.07812v-41.20801c0-2.24902-1.83008-4.0791-4.0791-4.0791Z"/>
<path d="M142.40313,229.87621h-8.85547c-.35938,0-.65137-.29199-.65137-.65137v-24.52832c0-.35938.29199-.65137.65137-.65137h8.85547c.35938,0,.65137.29199.65137.65137v24.52832c0,.35938-.29199.65137-.65137.65137ZM133.8963,228.87621h8.1582v-23.83105h-8.1582v23.83105Z"/>
<path d="M137.9754,124.17503c-2.47559,0-4.48926-2.01367-4.48926-4.48926s2.01367-4.49023,4.48926-4.49023,4.48926,2.01465,4.48926,4.49023-2.01367,4.48926-4.48926,4.48926ZM137.9754,116.19554c-1.92383,0-3.48926,1.56543-3.48926,3.49023,0,1.92383,1.56543,3.48926,3.48926,3.48926s3.48926-1.56543,3.48926-3.48926c0-1.9248-1.56543-3.49023-3.48926-3.49023Z"/>
<path d="M137.9754,185.77171c-1.32617,0-2.40527-1.07812-2.40527-2.4043s1.0791-2.40527,2.40527-2.40527,2.4043,1.0791,2.4043,2.40527-1.07812,2.4043-2.4043,2.4043ZM137.9754,181.96214c-.77441,0-1.40527.63086-1.40527,1.40527s.63086,1.4043,1.40527,1.4043,1.4043-.62988,1.4043-1.4043-.62988-1.40527-1.4043-1.40527Z"/>
<circle cx="176.9716" cy="220.70479" r="1.90475"/>
<circle cx="176.9716" cy="213.83113" r="1.90475"/>
<path d="M101.32403,159.23265c-2.80078,0-5.0791-2.27832-5.0791-5.07812v-41.20801c0-2.80078,2.27832-5.0791,5.0791-5.0791,2.7998,0,5.07812,2.27832,5.07812,5.0791v41.20801c0,2.7998-2.27832,5.07812-5.07812,5.07812ZM101.32403,108.86742c-2.24902,0-4.0791,1.83008-4.0791,4.0791v41.20801c0,2.24902,1.83008,4.07812,4.0791,4.07812s4.07812-1.8291,4.07812-4.07812v-41.20801c0-2.24902-1.8291-4.0791-4.07812-4.0791Z"/>
<path d="M105.75079,229.87621h-8.85449c-.35938,0-.65137-.29199-.65137-.65137v-24.52832c0-.35938.29199-.65137.65137-.65137h8.85449c.35938,0,.65137.29199.65137.65137v24.52832c0,.35938-.29199.65137-.65137.65137ZM97.24493,228.87621h8.15723v-23.83105h-8.15723v23.83105Z"/>
<path d="M101.32403,124.17503c-2.47559,0-4.49023-2.01367-4.49023-4.48926s2.01465-4.49023,4.49023-4.49023,4.48926,2.01465,4.48926,4.49023-2.01367,4.48926-4.48926,4.48926ZM101.32403,116.19554c-1.9248,0-3.49023,1.56543-3.49023,3.49023,0,1.92383,1.56543,3.48926,3.49023,3.48926,1.92383,0,3.48926-1.56543,3.48926-3.48926,0-1.9248-1.56543-3.49023-3.48926-3.49023Z"/>
<path d="M101.32403,185.77171c-1.32617,0-2.40527-1.07812-2.40527-2.4043s1.0791-2.40527,2.40527-2.40527,2.4043,1.0791,2.4043,2.40527-1.07812,2.4043-2.4043,2.4043ZM101.32403,181.96214c-.77441,0-1.40527.63086-1.40527,1.40527s.63086,1.4043,1.40527,1.4043,1.4043-.62988,1.4043-1.4043-.62988-1.40527-1.4043-1.40527Z"/>
<path d="M64.67169,159.23265c-2.7998,0-5.07812-2.27832-5.07812-5.07812v-41.20801c0-2.80078,2.27832-5.0791,5.07812-5.0791,2.80078,0,5.0791,2.27832,5.0791,5.0791v41.20801c0,2.7998-2.27832,5.07812-5.0791,5.07812ZM64.67169,108.86742c-2.24902,0-4.07812,1.83008-4.07812,4.0791v41.20801c0,2.24902,1.8291,4.07812,4.07812,4.07812s4.0791-1.8291,4.0791-4.07812v-41.20801c0-2.24902-1.83008-4.0791-4.0791-4.0791Z"/>
<path d="M69.09942,229.87621h-8.85547c-.3584,0-.65039-.29199-.65039-.65137v-24.52832c0-.35938.29199-.65137.65039-.65137h8.85547c.35938,0,.65137.29199.65137.65137v24.52832c0,.35938-.29199.65137-.65137.65137ZM60.59356,228.87621h8.15723v-23.83105h-8.15723v23.83105Z"/>
<path d="M64.67169,124.17503c-2.47559,0-4.48926-2.01367-4.48926-4.48926s2.01367-4.49023,4.48926-4.49023,4.48926,2.01465,4.48926,4.49023-2.01367,4.48926-4.48926,4.48926ZM64.67169,116.19554c-1.92383,0-3.48926,1.56543-3.48926,3.49023,0,1.92383,1.56543,3.48926,3.48926,3.48926s3.48926-1.56543,3.48926-3.48926c0-1.9248-1.56543-3.49023-3.48926-3.49023Z"/>
<path d="M64.67169,185.77171c-1.32617,0-2.4043-1.07812-2.4043-2.4043s1.07812-2.40527,2.4043-2.40527,2.40527,1.0791,2.40527,2.40527-1.0791,2.4043-2.40527,2.4043ZM64.67169,181.96214c-.77441,0-1.4043.63086-1.4043,1.40527s.62988,1.4043,1.4043,1.4043,1.40527-.62988,1.40527-1.4043-.63086-1.40527-1.40527-1.40527Z"/>
<path d="M28.02032,159.23265c-2.80078,0-5.0791-2.27832-5.0791-5.07812v-41.20801c0-2.80078,2.27832-5.0791,5.0791-5.0791,2.7998,0,5.07812,2.27832,5.07812,5.0791v41.20801c0,2.7998-2.27832,5.07812-5.07812,5.07812ZM28.02032,108.86742c-2.24902,0-4.0791,1.83008-4.0791,4.0791v41.20801c0,2.24902,1.83008,4.07812,4.0791,4.07812s4.07812-1.8291,4.07812-4.07812v-41.20801c0-2.24902-1.8291-4.0791-4.07812-4.0791Z"/>
<path d="M32.44806,229.87621h-8.85547c-.35938,0-.65137-.29199-.65137-.65137v-24.52832c0-.35938.29199-.65137.65137-.65137h8.85547c.3584,0,.65039.29199.65039.65137v24.52832c0,.35938-.29199.65137-.65039.65137ZM23.94122,228.87621h8.15723v-23.83105h-8.15723v23.83105Z"/>
<path d="M28.02032,124.17503c-2.47559,0-4.48926-2.01367-4.48926-4.48926s2.01367-4.49023,4.48926-4.49023,4.48926,2.01465,4.48926,4.49023-2.01367,4.48926-4.48926,4.48926ZM28.02032,116.19554c-1.92383,0-3.48926,1.56543-3.48926,3.49023,0,1.92383,1.56543,3.48926,3.48926,3.48926s3.48926-1.56543,3.48926-3.48926c0-1.9248-1.56543-3.49023-3.48926-3.49023Z"/>
<path d="M28.02032,185.77171c-1.32617,0-2.40527-1.07812-2.40527-2.4043s1.0791-2.40527,2.40527-2.40527,2.4043,1.0791,2.4043,2.40527-1.07812,2.4043-2.4043,2.4043ZM28.02032,181.96214c-.77441,0-1.40527.63086-1.40527,1.40527s.63086,1.4043,1.40527,1.4043,1.4043-.62988,1.4043-1.4043-.62988-1.40527-1.4043-1.40527Z"/>
<path d="M173.11369,52.78436l3.50867-6.43792c.13455-.24688.48902-.24688.62356,0l3.50867,6.43792c.12895.23661-.04231.525-.31178.525h-7.01733c-.26947,0-.44074-.28839-.31178-.525Z"/>`;

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export function createSp1Device(container, { onSelect } = {}) {
  const svg = el('svg', {
    viewBox: '0 0 204.01333 263.86756',
    role: 'group',
    'aria-label': 'SP-1 control surface. Select a control to edit its mapping.',
    class: 'sp1-device',
  });
  container.appendChild(svg);

  const body = el('g', { fill: 'var(--dim)', 'aria-hidden': 'true' }, svg);
  body.innerHTML = OUTLINE;

  const modeRow = el('g', { 'aria-hidden': 'true' }, svg);
  const modeLeds = [0, 1, 2, 3].map((i) =>
    el('circle', { cx: 162.5 + 5.2 * i, cy: 62, r: 1.6, fill: 'var(--accent)' }, modeRow));
  const trackRow = el('g', { 'aria-hidden': 'true' }, svg);
  const trackLeds = [0, 1, 2, 3].map((i) =>
    el('circle', { cx: FADER_X[i], cy: 183, r: 2.4, fill: 'var(--accent)' }, trackRow));

  let hover = null;
  let state = {};
  const controls = [];

  const activate = (sel) => (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    if (onSelect) onSelect(sel);
  };
  const wire = (g, key, sel) => {
    g.addEventListener('click', activate(sel));
    g.addEventListener('keydown', activate(sel));
    const on = () => { hover = key; render(); };
    const off = () => { if (hover === key) { hover = null; render(); } };
    g.addEventListener('mouseenter', on); g.addEventListener('focus', on);
    g.addEventListener('mouseleave', off); g.addEventListener('blur', off);
  };

  FADER_X.forEach((x, ix) => {
    const key = `f${ix}`;
    const g = el('g', { role: 'button', tabindex: 0, class: 'sp1-ctl' }, svg);
    const title = el('title', {}, g);
    const slot = el('rect', { x: x - 7, y: 105.5, width: 14, height: 56, rx: 7, fill: 'var(--accent)', 'stroke-width': 1 }, g);
    const thumb = el('line', { x1: x - 5.5, x2: x + 5.5, stroke: 'var(--accent)', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
    const text = el('text', { x, y: 101, 'text-anchor': 'middle', 'font-size': 6.5, 'font-family': 'var(--font-mono)' }, g);
    text.textContent = `F${ix + 1}`;
    wire(g, key, { kind: 'fader', ix });
    controls.push({ kind: 'fader', ix, key, g, title, shape: slot, thumb, text });
  });

  BUTTONS.forEach((b) => {
    const key = `b${b.ix}`;
    const g = el('g', { role: 'button', tabindex: 0, class: 'sp1-ctl' }, svg);
    const title = el('title', {}, g);
    const r = b.rect;
    const shape = el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: r.rx, fill: 'var(--accent)', 'stroke-width': 1 }, g);
    const text = el('text', { x: b.lab.x, y: b.lab.y, 'text-anchor': b.lab.anchor, 'font-size': 6.5, 'font-family': 'var(--font-mono)' }, g);
    text.textContent = b.label;
    wire(g, key, { kind: 'button', ix: b.ix });
    controls.push({ kind: 'button', ix: b.ix, key, g, title, shape, text, b });
  });

  const pressLayer = el('g', { 'aria-hidden': 'true', style: 'pointer-events:none' }, svg);

  function render() {
    const { monitor = {}, selected = null, labels = {}, reserved = [] } = state;
    for (const c of controls) {
      const isSel = selected && selected.kind === c.kind && selected.ix === c.ix;
      const isRes = c.kind === 'button' && reserved.includes(c.key);
      const live = c.kind === 'fader' ? typeof monitor[c.key] === 'number' : monitor[c.key] === 1;
      const lit = !isRes && (isSel || live);
      c.shape.setAttribute('fill-opacity', isSel ? 0.12 : live ? 0.07 : 0);
      c.shape.setAttribute('stroke', lit ? 'var(--accent)' : hover === c.key ? 'var(--ink)' : 'transparent');
      const showText = !isRes && (isSel || hover === c.key);
      c.text.style.display = showText ? '' : 'none';
      c.text.setAttribute('fill', isSel ? 'var(--accent)' : 'var(--ink)');
      c.g.setAttribute('aria-pressed', String(!!isSel));
      c.g.style.opacity = isRes ? '0.35' : '';
      c.g.setAttribute('tabindex', isRes ? -1 : 0);
      const label = labels[c.kind === 'fader' ? `F${c.ix + 1}` : c.b.id];
      const name = c.kind === 'fader' ? `Fader ${c.ix + 1}` : c.b.name;
      c.title.textContent = label ? `${name}: ${label}` : name;
      if (c.thumb) {
        const v = monitor[c.key];
        if (typeof v === 'number') {
          const y = 152 - (v / 127) * 38;
          c.thumb.setAttribute('y1', y); c.thumb.setAttribute('y2', y);
          c.thumb.style.display = '';
        } else c.thumb.style.display = 'none';
      }
    }
    const leds = (row, nodes, on, offOpacity) => {
      row.style.display = on ? '' : 'none';
      if (on) nodes.forEach((n, i) => n.setAttribute('fill-opacity', on[i] ? 1 : offOpacity));
    };
    leds(modeRow, modeLeds, state.modeLeds, 0.15);
    leds(trackRow, trackLeds, state.trackLeds, 0.12);

    pressLayer.replaceChildren();
    for (const p of state.pressed || []) {
      if (p === 'func') {
        el('rect', { x: 172.47, y: 209, width: 9, height: 16, rx: 4, fill: 'var(--accent)', 'fill-opacity': 0.5, class: 'sp1-pulse' }, pressLayer);
        continue;
      }
      const b = BUTTONS.find((x) => `b${x.ix}` === p);
      if (b) el('rect', { x: b.rect.x, y: b.rect.y, width: b.rect.w, height: b.rect.h, rx: b.rect.rx, fill: 'var(--accent)', 'fill-opacity': 0.5, class: 'sp1-pulse' }, pressLayer);
    }
  }

  render();
  return {
    svg,
    update(next) { state = { ...state, ...next }; render(); },
  };
}
