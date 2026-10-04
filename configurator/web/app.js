// app.js — the SP-1 configurator page.
//
// State lives in one object; every change goes through a mutator and ends in
// render(). The codec (codec.js) is the only thing that knows bytes; the
// transport (serial.js) the only thing that knows the wire. This file knows the
// object model: a feldd.com-compatible `sp1-profile` with top-level faders /
// buttons mirroring layer 0, `layers[8]`, `clock`, file-only `labels`, and the
// v10 `jack` block (names as in sp1ctl.py).

import * as codec from './codec.js';
import * as serial from './serial.js';
import * as templates from './templates.js';
import { createSp1Device, BUTTONS } from './sp1device.js';

// ---------------------------------------------------------------- constants --

const NUM_LAYERS = 8, NUM_FADERS = 4, NUM_BUTTONS = 9, SLOTS = 8;
const CONTROL_IDS = ['F1', 'F2', 'F3', 'F4', 'Play', 'T1', 'T2', 'T3', 'T4', 'Vol+', 'Vol-', 'FWD', 'RWD'];
const BUTTON_IDS = ['Play', 'T1', 'T2', 'T3', 'T4', 'Vol+', 'Vol-', 'FWD', 'RWD'];
const LABEL_MAX = 24;

const BUTTON_TYPES = [
  ['none', 'none'], ['note', 'note'], ['chord', 'Chord / notes'],
  ['cc_toggle', 'CC toggle (127/0)'], ['cc_momentary', 'CC momentary (127/0)'],
  ['cc_value', 'CC value'], ['transport', 'transport'], ['profile_switch', 'profile_switch'],
];
const TYPE_DEFAULT_VALUE = { none: 0, note: 60, chord: 0, cc_toggle: 20, cc_momentary: 20, cc_value: 127, transport: 0, profile_switch: 0 };
const QUALITIES = ['(pick)', 'maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus2', 'sus4'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

// Sync division: ticks per pulse at 24 PPQN, offered by musical name
// (ticks per pulse at 24 PPQN). Any other stored value 1..24 is shown as raw ticks.
// Short labels: eight of these sit side by side in the per-layer grid. The
// gear-facing explanation is one line under the grid, not in every option.
const SYNC_DIVS = [[24, '1/4'], [12, '1/8'], [8, '1/8T'], [6, '1/16'], [4, '1/16T'], [3, '1/32'], [2, '1/48'], [1, '1/96']];
const JACK_MODES = [[0, 'MIDI out'], [1, 'trigger'], [2, 'sync']];

// Keyboard mode: HID usages and modifier bits (feldd.com's encoding).
const KEY_CHOICES = (() => {
  const k = [['(none)', 0]];
  for (let i = 0; i < 26; i++) k.push([String.fromCharCode(65 + i), 4 + i]);
  for (let i = 1; i <= 9; i++) k.push([String(i), 29 + i]);
  k.push(['0', 39], ['Enter', 40], ['Esc', 41], ['Backspace', 42], ['Tab', 43], ['Space', 44]);
  for (let i = 1; i <= 12; i++) k.push([`F${i}`, 57 + i]);
  k.push(['Right', 79], ['Left', 80], ['Down', 81], ['Up', 82]);
  return k;
})();
const KEY_BY_USAGE = new Map(KEY_CHOICES.map(([n, u]) => [u, n]));
const MODS = [['Ctrl', 1], ['Shift', 2], ['Alt', 4], ['Cmd', 8]];
const CODE_TO_USAGE = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
  for (let i = 1; i <= 9; i++) m[`Digit${i}`] = 29 + i;
  Object.assign(m, { Digit0: 39, Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82 });
  for (let i = 1; i <= 12; i++) m[`F${i}`] = 57 + i;
  return m;
})();

// ------------------------------------------------------------------- state --

const S = {
  dev: null,          // transport (real or mock)
  demo: false,
  busy: false,
  hello: null,        // hello_r
  pver: null,         // profile version the device reports
  caps: [],
  mode: 0,            // 0 MIDI bank, 1 keyboard bank
  slot: 0,            // selected slot within the bank
  activeAbs: 0,       // device's active profile, absolute 0..15
  banks: [emptyBank(), emptyBank()],   // [mode][slot] = { working, saved }
  layer: 0,
  view: 'advanced',
  selected: { kind: 'fader', ix: 0 },
  monitor: {},
  midithru: null,
  blethru: null,      // null = unsupported or unknown
  jackLive: null,     // trsmode_r while connected
  capture: null,      // { slot ix } while capturing a key
  log: [],
  logOpen: false,
};
function emptyBank() { return Array.from({ length: SLOTS }, () => ({ working: null, saved: null })); }

const cur = () => S.banks[S.mode][S.slot];
const prof = () => cur().working;
const hasJackCap = () => S.caps.includes('trsout') || (S.pver ?? 0) >= 10;
const encodeVersion = () => codec.pickEncodeVersion(S.hello);

// --------------------------------------------------------- codec adapters --
// Everything codec-shaped goes through these, so the page never touches bytes.

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
function decodeB64(b64) { return codec.profileFromBase64(b64); }
function encodeB64(p, version = encodeVersion()) { return codec.profileToBase64(p, version); }
function sameBytes(a, b) {
  if (!a || !b) return a === b;
  try { return encodeB64(a, 10) === encodeB64(b, 10); } catch { return false; }
}
function normalize(p) {
  // Round-trip through the codec: validates, fills layers, attaches jack defaults.
  const labels = p.labels;
  const out = decodeB64(encodeB64(p, 10));
  if (labels) out.labels = normalizeLabels(labels);
  return out;
}
// Offline reset loads the first starter, as feldd.com does; online, the device's own reset wins.
function blankProfile() { return normalize(clone(templates.TEMPLATES[0].profile)); }
function jackOf(p) {
  const d = codec.JACK_DEFAULTS;
  const j = p.jack || {};
  return {
    mode: j.mode ?? d.mode,
    width: j.width ?? d.width,
    trigger_note: [...(j.trigger_note ?? d.trigger_note)],
    trigger_channel: [...(j.trigger_channel ?? d.trigger_channel)],
    sync_div: [...(j.sync_div ?? d.sync_div)],
  };
}
function normalizeLabels(labels) {
  // feldd.com: up to eight per-layer maps keyed by control id, values trimmed
  // to 24 chars; a single legacy object is replicated to every layer.
  if (!labels) return undefined;
  const arr = Array.isArray(labels) ? labels : Array.from({ length: NUM_LAYERS }, () => labels);
  const out = arr.slice(0, NUM_LAYERS).map((m) => {
    const o = {};
    for (const id of CONTROL_IDS) {
      const v = typeof m?.[id] === 'string' ? m[id].trim().slice(0, LABEL_MAX) : '';
      if (v) o[id] = v;
    }
    return o;
  });
  while (out.length && !Object.keys(out[out.length - 1]).length) out.pop();
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------- mutators --

function edit(fn) {
  const p = prof();
  if (!p) return;
  fn(p);
  render();
}
function setLayer(p, L, field, i, v) {
  p.layers[L][field][i] = v;
  if (L !== 0) return;
  // Layer 0 is mirrored into the top-level objects the encoder also reads.
  const F = { fader_cc: 'cc', fader_min: 'min', fader_max: 'max', fader_curve: 'curve', fader_invert: 'invert', fader_channel: 'channel' };
  const B = { button_type: 'type', button_value: 'value', button_channel: 'channel' };
  if (F[field] && p.faders[i]) p.faders[i][F[field]] = v;
  if (B[field] && p.buttons[i]) p.buttons[i][B[field]] = v;
}
function setLabel(p, L, id, text) {
  const labels = normalizeLabels(p.labels) || [];
  while (labels.length <= L) labels.push({});
  const t = text.trim().slice(0, LABEL_MAX);
  if (t) labels[L][id] = t; else delete labels[L][id];
  p.labels = normalizeLabels(labels);
}
const labelOf = (p, L, id) => (normalizeLabels(p?.labels)?.[L]?.[id]) || '';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));

// ----------------------------------------------------------------- the wire --

function logLine(dir, text) {
  const t0 = logLine.t0 ?? (logLine.t0 = performance.now());
  S.log.push(`+${((performance.now() - t0) / 1000).toFixed(2)}s ${dir} ${text}`);
  if (S.log.length > 500) S.log.shift();
  renderLog();
}

async function connect(useDemo) {
  clearError();
  S.busy = true; render();
  try {
    const dev = useDemo ? new serial.MockSp1Serial() : new serial.Sp1Serial();
    serial.setSerialLogSink((...parts) => logLine('', parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
    await dev.connect();
    S.dev = dev; S.demo = !!useDemo;
    dev.on('mon', onMon);
    dev.on('active', (m) => { S.activeAbs = m.n; S.mode = Math.floor(m.n / SLOTS); S.slot = m.n % SLOTS; render(); });
    dev.on('mode', (m) => { S.mode = m.v; render(); });
    dev.on('disconnect', () => onDisconnect());

    let hello = null;
    try { hello = await dev.request('hello'); } catch { /* fail open, as feldd.com does */ }
    S.hello = hello;
    S.pver = typeof hello?.pver === 'number' ? hello.pver : null;
    S.caps = Array.isArray(hello?.caps) ? hello.caps : [];
    try { const l = await dev.request('list'); S.activeAbs = l.active ?? 0; S.mode = l.mode ?? 0; } catch { S.activeAbs = 0; }

    const total = (hello?.profiles ?? 8) >= 16 ? 16 : 8;
    const banks = [emptyBank(), emptyBank()];
    for (let n = 0; n < total; n++) {
      try {
        const r = await dev.request('read', { n });
        const p = r.data ? decodeB64(r.data) : r.profile;
        if (p) banks[Math.floor(n / SLOTS)][n % SLOTS] = { working: clone(p), saved: clone(p) };
      } catch { /* slot left empty */ }
    }
    S.banks = banks;
    try { const m = await dev.getMode(); S.mode = m; } catch {}
    S.slot = S.activeAbs % SLOTS;
    try { await dev.request('monset', { on: true }); } catch {}
    try { S.midithru = await dev.getMidiThru(); } catch { S.midithru = null; }
    try { S.blethru = await dev.getBleThru(); } catch { S.blethru = null; }
    await refreshJackLive();
    if (S.pver != null && S.pver < 9) showBanner(`This SP-1 runs an older feldd (profile v${S.pver}). Editing needs profile v9 or newer — export your profiles, then update the firmware.`);
    else if (S.pver === 9) showBanner('This SP-1 runs profile v9 firmware: everything works except the per-profile TRS sync jack modes, which need the v10 build.');
    else hideBanner();
  } catch (e) {
    showError(e);
    S.dev = null;
  } finally {
    S.busy = false; render();
  }
}

async function disconnect() {
  try { await S.dev?.close(); } catch {}
  onDisconnect();
}
function onDisconnect() {
  S.dev = null; S.demo = false; S.hello = null; S.monitor = {}; S.midithru = null; S.blethru = null; S.jackLive = null;
  render();
}
function onMon(m) {
  if (m.k === 'f') S.monitor[`f${m.ix}`] = m.v;
  else if (m.k === 'b') S.monitor[`b${m.ix}`] = m.s ? 1 : 0;
  renderLive();
}
async function refreshJackLive() {
  if (!S.dev || !hasJackCap()) { S.jackLive = null; return; }
  try { S.jackLive = await S.dev.request('trsmode'); } catch { S.jackLive = null; }
}

async function saveSlot(mode, slot) {
  const e = S.banks[mode][slot];
  if (!S.dev || !e.working) return;
  const p = e.working;
  if (encodeVersion() === 9 && !isDefaultJack(p)) {
    throw new Error('This device runs v9 firmware, which has no per-profile TRS sync jack modes — the sync jack settings in this profile will not be saved.');
  }
  await S.dev.request('write', { n: mode * SLOTS + slot, data: encodeB64(p) });
  e.saved = clone(p);
}
function isDefaultJack(p) {
  const a = jackOf(p), d = codec.JACK_DEFAULTS;
  return a.mode === d.mode && a.width === d.width &&
    a.trigger_note.every((v, i) => v === d.trigger_note[i]) &&
    a.trigger_channel.every((v, i) => v === d.trigger_channel[i]) &&
    a.sync_div.every((v, i) => v === d.sync_div[i]);
}
const isDirty = (e) => !!e.working && (!e.saved || !sameBytes(e.saved, e.working));

async function onSave() {
  S.busy = true; render();
  try { await saveSlot(S.mode, S.slot); await refreshJackLive(); } catch (e) { showError(e); }
  S.busy = false; render();
}
async function onSaveAll() {
  const dirty = S.banks[S.mode].map((e, i) => (isDirty(e) ? i : -1)).filter((i) => i >= 0);
  S.busy = true;
  try {
    for (let k = 0; k < dirty.length; k++) {
      $('btn-save-all').textContent = `Saving (${k}/${dirty.length})`;
      await saveSlot(S.mode, dirty[k]);
    }
    await refreshJackLive();
  } catch (e) { showError(e); }
  S.busy = false; render();
}

// ---------------------------------------------------------------- librarian --

async function selectSlot(i) {
  S.slot = i;
  if (S.dev) {
    try { await S.dev.request('setactive', { n: i }); S.activeAbs = S.mode * SLOTS + i; await refreshJackLive(); } catch (e) { showError(e); }
  }
  render();
}
async function selectMode(m) {
  if (m === 1 && S.pver != null && S.pver < 3) return showError('Keyboard mode needs feldd v0.7.1+.');
  S.mode = m;
  if (S.dev) {
    try { await S.dev.setMode(m); const l = await S.dev.request('list'); S.activeAbs = l.active ?? S.activeAbs; } catch (e) { showError(e); }
    await refreshJackLive();
  }
  S.slot = S.activeAbs >= m * SLOTS && S.activeAbs < (m + 1) * SLOTS ? S.activeAbs % SLOTS : 0;
  render();
}
function onDuplicate() {
  const p = prof(); if (!p) return;
  const bank = S.banks[S.mode];
  let to = bank.findIndex((e) => !e.working);
  if (to < 0) {
    if (!confirm('No empty slot in this bank. Overwrite the next slot?')) return;
    to = (S.slot + 1) % SLOTS;
  }
  const copy = clone(p);
  copy.name = truncUtf8(`${p.name || 'untitled'} copy`, 16);
  bank[to].working = copy;
  S.slot = to; render();
}
async function onReset() {
  if (!confirm('Restore this slot to the default mapping?')) return;
  if (S.dev) {
    try {
      const n = S.mode * SLOTS + S.slot;
      await S.dev.request('reset', { n });
      const r = await S.dev.request('read', { n });
      const p = r.data ? decodeB64(r.data) : r.profile;
      S.banks[S.mode][S.slot] = { working: clone(p), saved: clone(p) };
      await refreshJackLive();
    } catch (e) { showError(e); }
  } else {
    cur().working = blankProfile();
  }
  render();
}
function truncUtf8(s, max) {
  const enc = new TextEncoder();
  let out = '';
  for (const ch of s) { if (enc.encode(out + ch).length > max) break; out += ch; }
  return out;
}
function slug(s) { return (s || 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'; }
function download(name, obj) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// A profile whose jack is untouched loses nothing as v9, so it is written as v9
// with no jack block: feldd.com's importer rejects any version above 9, and a
// backup that only this page can read would strand anyone going back to
// upstream feldd. Only a profile that really uses the jack is written as v10.
function forFile(p) {
  const o = clone(p);
  if (isDefaultJack(o)) { delete o.jack; o.version = 9; } else { o.jack = jackOf(o); o.version = 10; }
  return o;
}
function onExport() {
  const p = prof(); if (!p) return;
  normalize(p); // validates; throws on a bad profile
  download(`${slug(p.name)}.feldd`, { ...forFile(p), format: 'sp1-profile' });
}
function onExportAll() {
  const profiles = [];
  S.banks.forEach((bank, m) => bank.forEach((e, slot) => {
    if (e.working) profiles.push({ mode: m ? 'keyboard' : 'midi', slot, profile: forFile(normalize(e.working)) });
  }));
  const v10 = profiles.filter((x) => x.profile.version === 10).length;
  if (v10) showBanner(`${v10} profile(s) in this backup use the TRS sync jack (profile v10): only this configurator can import those; the rest also import at feldd.com.`);
  download('feldd-all-profiles.feldd', { format: 'sp1-bundle', version: 1, profiles });
}
async function onImportFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj?.format === 'sp1-bundle') {
      const seen = new Set();
      for (const e of obj.profiles || []) {
        const key = `${e.mode}:${e.slot}`;
        if (!['midi', 'keyboard'].includes(e.mode) || !Number.isInteger(e.slot) || e.slot < 0 || e.slot > 7) throw new Error(`bad bundle entry ${key}`);
        if (seen.has(key)) throw new Error(`bundle has a duplicate entry ${key}`);
        seen.add(key);
      }
      if (!confirm(`Import ${obj.profiles.length} profiles? Each one replaces the slot it names, in both banks. Nothing is written to the SP-1 until you save.`)) return;
      for (const e of obj.profiles) S.banks[e.mode === 'keyboard' ? 1 : 0][e.slot].working = normalize(e.profile);
    } else if (obj?.format === 'sp1-profile') {
      cur().working = normalize(obj);
    } else {
      throw new Error('expected format "sp1-profile" or "sp1-bundle"');
    }
    render();
  } catch (e) { showError(e); }
}

// ----------------------------------------------------------- starters/fill --

function loadStarter(value) {
  if (!value) return;
  if (value === '__pack') {
    // feldd.com's eight-slot pack order; FL Studio is offered individually only.
    const ids = ['tp7-remote', 'opxy-mixer', 'op1-field', 'tx6-mixer', 'dirtywave-m8', 'roland-aira', 'ableton-live', 'logic-pro'];
    if (!confirm('Load the starter pack into all 8 slots of the MIDI bank? Nothing is written to the SP-1 until you save.')) return;
    S.mode = 0;
    ids.forEach((id, i) => {
      const t = templates.TEMPLATES.find((x) => x.id === id);
      if (t) S.banks[0][i].working = normalize(clone(t.profile));
    });
  } else {
    const t = templates.TEMPLATES.find((x) => x.id === value);
    if (t) cur().working = normalize(clone(t.profile));
  }
  render();
}
function autofill() {
  const scope = $('af-scope').value, down = $('af-dir').value === 'down';
  let v = clamp($('af-start').value, 0, 127);
  const slots = scope === 'all' ? [...Array(SLOTS).keys()] : [S.slot];
  const layers = scope === 'layer' ? [S.layer] : [...Array(NUM_LAYERS).keys()];
  for (const s of slots) {
    const p = S.banks[S.mode][s].working;
    for (const L of layers) for (let f = 0; f < NUM_FADERS; f++) {
      if (p) setLayer(p, L, 'fader_cc', f, clamp(v, 0, 127));
      v += down ? -1 : 1;
    }
  }
  render();
}

// ---------------------------------------------------------------- rendering --

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') n.className = v;
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}
const num = (value, min, max, on, extra = {}) =>
  h('input', { type: 'number', min, max, value, onchange: (e) => on(clamp(e.target.value, min, max)), ...extra });
const sel = (value, options, on, extra = {}) =>
  h('select', { onchange: (e) => on(e.target.value), ...extra },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
const chSel = (value, on) => sel(value, Array.from({ length: 16 }, (_, i) => [i, i + 1]), (v) => on(Number(v)));

let device;

function render() {
  renderHeader();
  renderLibrarian();
  renderDeviceSettings();
  renderToolbar();
  renderJack();
  renderClock();
  renderEditor();
  renderLive();
  renderLog();
}

function renderHeader() {
  const on = !!S.dev;
  $('conn-status').textContent = on ? (S.demo ? 'connected (demo)' : 'connected') : 'not connected';
  $('conn-status').classList.toggle('on', on);
  $('btn-connect').hidden = on; $('btn-demo').hidden = on; $('btn-disconnect').hidden = !on;
  $('btn-connect').disabled = S.busy || !('serial' in navigator);
  $('btn-connect').textContent = S.busy && !on ? 'Connecting…' : 'Connect your SP-1 →';
  if (!('serial' in navigator) && !$('banner').textContent) showBanner('Heads up: connecting needs a Chromium browser (Chrome, Edge, Arc) for WebSerial. Import, export, editing and Demo work here.');
}

function renderLibrarian() {
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.mode) === S.mode)));
  // Removing a focused rename box fires its blur synchronously, mid-rebuild;
  // that blur must not commit and end the rename.
  const ol = $('slots');
  const prevBox = ol.querySelector('input');
  const prevSel = prevBox ? [prevBox.selectionStart, prevBox.selectionEnd] : null;
  S.rebuildingSlots = true; ol.replaceChildren(); S.rebuildingSlots = false;
  // A rename lives in state, not in a stray DOM node: selecting the slot sends
  // `setactive`, and the device's reply re-renders this list a few ms later --
  // which, when the box was only a DOM node, wiped it out mid-double-click.
  let renameInput = null;
  S.banks[S.mode].forEach((e, i) => {
    const name = e.working ? (e.working.name || 'untitled') : 'empty';
    const renaming = S.rename && S.rename.mode === S.mode && S.rename.slot === i && e.working;
    let nameEl;
    if (renaming) {
      nameEl = h('input', { type: 'text', value: S.rename.draft, maxlength: 16, 'aria-label': `rename profile in slot ${i + 1}` });
      const done = (commit) => {
        if (!S.rename) return;
        if (commit) e.working.name = truncUtf8(nameEl.value, 16);
        S.rename = null; render();
      };
      nameEl.addEventListener('input', () => { if (S.rename) S.rename.draft = nameEl.value; });
      nameEl.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      nameEl.addEventListener('click', (ev) => ev.stopPropagation());
      nameEl.addEventListener('dblclick', (ev) => ev.stopPropagation());
      // A re-render replaces this node; only a blur on the LIVE box commits.
      nameEl.addEventListener('blur', () => { if (!S.rebuildingSlots && nameEl.isConnected) done(true); });
      renameInput = nameEl;
    } else {
      nameEl = h('span', { class: `name${e.working ? '' : ' empty'}`, title: 'double-click to rename' }, name);
    }
    const li = h('li', {
      class: [i === S.slot && 'sel', S.dev && S.activeAbs === S.mode * SLOTS + i && 'active'].filter(Boolean).join(' '),
      onclick: () => { if (!renaming) selectSlot(i); },
      ondblclick: () => {
        if (!e.working || renaming) return;
        S.rename = { mode: S.mode, slot: i, draft: e.working.name || '', fresh: true };
        render();
      },
    }, h('span', { class: 'num' }, String(i + 1).padStart(2, '0')), nameEl,
      h('span', { class: `dot ${e.working ? (isDirty(e) ? 'dirty' : (e.saved ? 'saved' : '')) : ''}`, title: isDirty(e) ? 'unsaved changes' : 'saved' }));
    ol.append(li);
  });
  if (renameInput) {
    renameInput.focus();
    if (S.rename.fresh) { renameInput.select(); S.rename.fresh = false; }
    else if (prevSel) renameInput.setSelectionRange(prevSel[0], prevSel[1]);   // as the user left it
  }
  $('btn-dup').disabled = !prof();
  $('btn-export').disabled = !prof();
  $('btn-export-all').disabled = !S.banks.some((b) => b.some((e) => e.working));
}

function renderDeviceSettings() {
  const on = !!S.dev;
  $('device-offline').hidden = on; $('device-online').hidden = !on;
  if (!on) return;
  const seg = (id, v) => document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.v) === v)));
  seg('thru-trs', S.midithru);
  $('row-blethru').hidden = S.blethru == null;
  seg('thru-ble', S.blethru);
  const jackNote = hasJackCap() && S.midithru === 1 && jackOf(prof() || {}).mode !== 0 ? ' · thru is inert while this profile\'s TRS sync jack is not MIDI' : '';
  $('fw-line').textContent = `feldd ${S.hello?.fw ?? '?'} · profile v${S.pver ?? '?'}${jackNote}`;
}

function layerLocked(L) {
  if (S.pver == null) return false;
  if (S.mode === 1 && L >= 1 && S.pver < 4) return true;
  if (L >= 2 && S.pver < 5) return true;
  if (L >= 4 && S.pver < 9) return true;
  return false;
}

function renderToolbar() {
  const lt = $('layer-tabs'); lt.replaceChildren();
  for (let L = 0; L < NUM_LAYERS; L++) {
    const locked = layerLocked(L);
    lt.append(h('button', {
      'aria-selected': String(L === S.layer), class: locked ? 'locked' : '', disabled: locked,
      title: locked ? 'update firmware for this layer' : 'Layer 1 is your base; layers 2-8 are alternate pages (tap PLAY to step, or tap 2-8 times fast to jump).',
      onclick: () => { S.layer = L; render(); },
    }, `L${L + 1}`));
  }
  document.querySelectorAll('#view-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === S.view)));
  const p = prof();
  $('all-ch').disabled = !p;
  if (p) $('all-ch').value = (p.channel ?? 0) + 1;
  const e = cur();
  const dirty = isDirty(e);
  const save = $('btn-save');
  save.disabled = !S.dev || !dirty || S.busy || (S.pver != null && S.pver < 9);
  save.classList.toggle('dirty', dirty);
  save.textContent = dirty ? 'Save changes → device' : 'Saved';
  const nDirty = S.banks[S.mode].filter(isDirty).length;
  const sa = $('btn-save-all');
  sa.disabled = !S.dev || !nDirty || S.busy || (S.pver != null && S.pver < 9);
  if (!S.busy) sa.textContent = nDirty ? `Save all (${nDirty})` : 'Save all';
  const st = $('starter');
  if (!st.options.length) {
    st.append(h('option', { value: '' }, 'load a starter'), h('option', { value: '__pack' }, 'Starter pack (all 8)'));
    for (const t of templates.TEMPLATES || []) st.append(h('option', { value: t.id }, t.label || t.name || t.id));
  }
}

function renderJack() {
  const body = $('jack-body'); body.replaceChildren();
  const p = prof();
  const supported = !S.dev || hasJackCap();
  $('jack-unsupported').hidden = supported;
  if (!p || !supported) return;
  const j = jackOf(p);
  const put = (fn) => edit((q) => { const jj = jackOf(q); fn(jj); q.jack = jj; });

  const modes = h('div', { class: 'seg' }, JACK_MODES.map(([v, label]) =>
    h('button', { 'aria-selected': String(j.mode === v), onclick: () => put((jj) => { jj.mode = v; }) }, label)));
  body.append(h('div', { class: 'row wrap' }, modes,
    j.mode === 0 ? h('span', { class: 'muted small' }, 'the TRS sync jack is ordinary MIDI out (Type A)') : null));
  if (j.mode === 0) { renderJackDiag(body); return; }

  body.append(h('div', { class: 'row wrap' },
    h('label', { class: 'inline', title: 'pulse length. 10 ms suits most trigger and clock inputs; some inputs that fire on both edges want it shorter.' }, 'pulse width',
      h('input', { type: 'number', min: 0.1, max: 25.5, step: 0.1, value: (j.width / 10).toFixed(1),
        onchange: (e) => put((jj) => { jj.width = clamp(Math.round(Number(e.target.value) * 10), 1, 255); }) }), 'ms')));

  // Per-layer values: shown once when every layer agrees, as a grid otherwise.
  const fields = j.mode === 1 ? ['trigger_note', 'trigger_channel'] : ['sync_div'];
  const uniform = fields.every((f) => j[f].every((v) => v === j[f][0]));
  const perLayer = S.jackExpanded || !uniform;
  const cell = (f, L) => {
    const setAll = (v) => put((jj) => { if (perLayer) jj[f][L] = v; else jj[f].fill(v); });
    if (f === 'trigger_note') return h('span', {}, num(j[f][L], 0, 127, setAll, { title: noteName(j[f][L]) }));
    if (f === 'trigger_channel') return sel(j[f][L], [[0, 'omni'], ...Array.from({ length: 16 }, (_, i) => [i + 1, i + 1])], (v) => setAll(Number(v)));
    const opts = SYNC_DIVS.some(([t]) => t === j[f][L]) ? SYNC_DIVS : [...SYNC_DIVS, [j[f][L], `${j[f][L]} ticks`]];
    return sel(j[f][L], opts, (v) => setAll(Number(v)));
  };
  const names = { trigger_note: 'note', trigger_channel: 'channel', sync_div: 'division' };
  if (!perLayer) {
    body.append(h('div', { class: 'fields', style: 'margin-top:10px' },
      fields.flatMap((f) => [h('label', {}, names[f]), cell(f, 0)])));
  } else {
    // Wide panel: L1..L8 across in one block. Narrow panel: the same layout folded
    // into two blocks of four (L1-L4, then L5-L8) -- eight columns beside the row
    // labels cannot fit below ~600 px (bench, 2026-10-03), and a sideways scroll hid
    // L7-L8. Two rows of four was Ryan's call.
    const across = ($('jack-panel').clientWidth || 9999) >= 600;
    const blocks = across ? [[0, 8]] : [[0, 4], [4, 8]];
    const grid = h('div', { class: `jack-grid${across ? '' : ' half'}` });
    for (const [from, to] of blocks) {
      grid.append(h('span'), ...Array.from({ length: to - from }, (_, k) => h('span', { class: 'hd' }, `L${from + k + 1}`)));
      for (const f of fields) {
        grid.append(h('span', { class: 'rowlabel' }, names[f]));
        for (let L = from; L < to; L++) grid.append(cell(f, L));
      }
    }
    body.append(grid);
  }
  body.append(h('label', { class: 'inline', style: 'margin-top:8px' },
    h('input', { type: 'checkbox', checked: perLayer, disabled: !uniform,
      onchange: (e) => { S.jackExpanded = e.target.checked; render(); } }),
    uniform ? 'different per layer' : 'different per layer (layers differ)'));
  body.append(h('p', { class: 'muted small' }, j.mode === 1
    ? 'Pulses when a matching note arrives — from USB or from a button mapped to that note. Layers let one profile trigger on a kick in L1 and a rimshot in L2.'
    : 'Pulses on a division of MIDI clock — from USB or the SP-1\'s own clock. 1/8 is 2 PPQN, the Pocket Operator / Volca rate; 1/96 is every clock tick (24 PPQN).'));
  renderJackDiag(body);
}
function renderJackDiag(body) {
  if (!S.dev || !S.jackLive) return;
  const live = S.jackLive;
  const liveMode = live.live ?? live.v;
  const name = JACK_MODES.find(([v]) => v === liveMode)?.[1] ?? '?';
  const isActive = S.activeAbs === S.mode * SLOTS + S.slot;
  const unsaved = isActive && isDirty(cur()) && jackOf(prof()).mode !== liveMode;
  const note = !isActive ? 'this profile is not the active one on the SP-1 — select it to hear it'
    : unsaved ? 'save to apply' : null;
  body.append(h('div', { class: 'jack-diag' },
    h('span', {}, `on the device now: ${name}`),
    h('span', {}, `· pulses fired ${live.fires ?? 0}`),
    live.fault ? h('span', { style: 'color:var(--warn)' }, '· pin fault') : null,
    note ? h('span', {}, `· ${note}`) : null,
    h('button', { class: 'small', disabled: liveMode === 0, title: 'fire one pulse now, bypassing note matching and the clock divider — for checking the cable and the receiving input',
      onclick: async () => { try { await S.dev.request('trspulse'); await refreshJackLive(); render(); } catch (e) { showError(e); } } }, 'test pulse'),
    h('button', { class: 'small ghost', onclick: async () => { await refreshJackLive(); render(); } }, 'refresh')));
}

function renderClock() {
  const panel = $('clock-panel'); panel.replaceChildren();
  const p = prof(); if (!p || S.mode === 1) { panel.hidden = true; return; }
  panel.hidden = false;
  const c = { enable: false, tapButton: 4, bpmFader: 3, defaultBpm: 120, ...(p.clock || {}) };
  const put = (fn) => edit((q) => { const cc = { enable: false, tapButton: 4, bpmFader: 3, defaultBpm: 120, ...(q.clock || {}) }; fn(cc); q.clock = cc; });
  panel.append(h('h2', {}, 'MIDI clock', h('span', { class: 'hint', title: 'when on, streams MIDI clock out the TRS sync jack (and passes an incoming USB clock through). the tap button and BPM fader are borrowed from their normal jobs while the clock is on. per-profile: switching to a profile with the clock off stops it.' }, '?')));
  const taps = [[1, 'Track 1'], [2, 'Track 2'], [3, 'Track 3'], [4, 'Track 4'], [5, 'Vol +'], [6, 'Vol −'], [7, 'FWD'], [8, 'RWD'], [15, 'none']];
  panel.append(h('div', { class: 'row wrap' },
    h('div', { class: 'seg small' }, [[false, 'off'], [true, 'on']].map(([v, l]) =>
      h('button', { 'aria-selected': String(!!c.enable === v), onclick: () => put((cc) => { cc.enable = v; }) }, l))),
    h('label', { class: 'inline' }, 'tap tempo', sel(c.tapButton, taps, (v) => put((cc) => { cc.tapButton = Number(v); }), { disabled: !c.enable })),
    h('label', { class: 'inline' }, 'BPM fader', sel(c.bpmFader, [[0, 'Fader 1'], [1, 'Fader 2'], [2, 'Fader 3'], [3, 'Fader 4'], [7, 'none']], (v) => put((cc) => { cc.bpmFader = Number(v); }), { disabled: !c.enable })),
    h('label', { class: 'inline' }, 'default BPM', num(c.defaultBpm, 40, 240, (v) => put((cc) => { cc.defaultBpm = v; }), { disabled: !c.enable }))));
}

// -------------------------------------------------------------- the editor --

function faderCard(p, L, f) {
  const lay = p.layers[L];
  const id = `F${f + 1}`;
  const set = (field) => (v) => edit((q) => setLayer(q, L, field, f, v));
  const depthElsewhere = lay.fader_role.some((r, i) => r === 1 && i !== f);
  const isSel = S.selected?.kind === 'fader' && S.selected.ix === f;
  const live = S.monitor[`f${f}`];
  return h('div', { class: `card${isSel ? ' sel' : ''}`, 'data-ctl': `f${f}`, onclick: () => { S.selected = { kind: 'fader', ix: f }; renderLive(); } },
    h('h3', {}, `Fader ${f + 1}${L ? ` (L${L + 1})` : ''}`, h('span', { class: 'lbl' }, labelOf(p, L, id))),
    h('div', { class: 'fields' },
      h('label', {}, 'label'), h('input', { type: 'text', maxlength: LABEL_MAX, value: labelOf(p, L, id), placeholder: 'e.g. env attack',
        title: 'an optional note, saved in the .feldd file, NOT sent to the device.', onchange: (e) => edit((q) => setLabel(q, L, id, e.target.value)) }),
      h('label', { title: 'the MIDI CC number this fader sends (0-127).' }, 'cc'), num(lay.fader_cc[f], 0, 127, set('fader_cc')),
      h('label', {}, 'ch'), chSel(lay.fader_channel[f], set('fader_channel')),
      h('label', {}, 'min'), num(lay.fader_min[f], 0, 127, set('fader_min')),
      h('label', {}, 'max'), num(lay.fader_max[f], 0, 127, set('fader_max')),
      h('label', { title: 'linear is 1:1, log gives finer control down low, exp finer up high.' }, 'curve'),
      sel(lay.fader_curve[f], [['linear', 'linear'], ['log', 'log'], ['exp', 'exp']], set('fader_curve')),
      h('label', { title: 'flip the direction - the top of the fader sends the low value.' }, 'invert'),
      h('input', { type: 'checkbox', checked: !!lay.fader_invert[f], onchange: (e) => set('fader_invert')(e.target.checked) }),
      S.mode === 0 ? [h('label', { title: 'Chord depth: this fader\'s position (read on press) stacks 7th/9th/11th/13th onto root+quality chord buttons. The fader still sends its CC.' }, 'role'),
        h('select', { onchange: (e) => set('fader_role')(Number(e.target.value)) },
          h('option', { value: 0, selected: lay.fader_role[f] === 0 }, 'CC'),
          h('option', { value: 1, selected: lay.fader_role[f] === 1, disabled: depthElsewhere }, 'Chord depth'))] : null),
    h('div', { class: 'livebar' }, h('span', { style: `width:${typeof live === 'number' ? (live / 127) * 100 : 0}%` })));
}

function buttonCard(p, L, b) {
  const lay = p.layers[L];
  const id = BUTTON_IDS[b];
  const isSel = S.selected?.kind === 'button' && S.selected.ix === b;
  const down = S.monitor[`b${b}`] === 1;
  const head = h('h3', {}, `${BUTTONS[b].name}${L ? ` (L${L + 1})` : ''}`, h('span', { class: 'lbl' }, labelOf(p, L, id)));
  const labelRow = [h('label', {}, 'label'), h('input', { type: 'text', maxlength: LABEL_MAX, value: labelOf(p, L, id), placeholder: 'e.g. solo tr 2',
    title: 'an optional note, saved in the .feldd file, NOT sent to the device.', onchange: (e) => edit((q) => setLabel(q, L, id, e.target.value)) })];
  const card = (body) => h('div', { class: `card${isSel ? ' sel' : ''}${down ? ' live' : ''}`, 'data-ctl': `b${b}`,
    onclick: () => { S.selected = { kind: 'button', ix: b }; renderLive(); } }, head, body);

  if (S.mode === 1) return card(keyFields(p, L, b, labelRow));

  const type = lay.button_type[b];
  const setT = (t) => edit((q) => {
    setLayer(q, L, 'button_type', b, t);
    setLayer(q, L, 'button_value', b, TYPE_DEFAULT_VALUE[t] ?? 0);
    if (t === 'cc_value') q.layers[L].cc_values[b] = { sub_mode: 0, on: 127, off: 0 };
  });
  const rows = [...labelRow,
    h('label', { title: 'what the button does.' }, 'type'), sel(type, BUTTON_TYPES, setT)];
  if (type === 'chord') rows.push(...chordFields(p, L, b));
  else if (type === 'cc_value') rows.push(...ccValueFields(p, L, b));
  else if (type !== 'none') {
    const hint = { note: noteName(lay.button_value[b]), transport: 'transport id (1 start, 2 stop)', profile_switch: 'slot to switch to' }[type] || 'CC number';
    rows.push(h('label', { title: 'depends on the type: the note number, CC number, transport id, or the slot to switch to.' }, 'value'),
      h('span', { class: 'row' }, num(lay.button_value[b], 0, 127, (v) => edit((q) => setLayer(q, L, 'button_value', b, v))), h('span', { class: 'muted small' }, hint)));
  }
  if (type !== 'none') rows.push(h('label', {}, 'ch'), chSel(lay.button_channel[b], (v) => edit((q) => setLayer(q, L, 'button_channel', b, v))));
  return card(h('div', { class: 'fields' }, rows));
}

function chordFields(p, L, b) {
  const c = p.layers[L].chords[b];
  const put = (fn) => edit((q) => { const cc = q.layers[L].chords[b]; fn(cc); });
  const rows = [];
  rows.push(h('label', {}, 'root'), sel(c.mode === 2 ? c.root : 48, Array.from({ length: 12 }, (_, i) => [48 + i, noteName(48 + i)]),
    (v) => put((cc) => { if (cc.mode === 2) cc.root = Number(v); else { cc.mode = 2; cc.root = Number(v); cc.qual = 1; cc.count = 0; } })));
  rows.push(h('label', {}, 'quality'), sel(c.mode === 2 ? c.qual : 0, QUALITIES.map((q, i) => [i, q]),
    (v) => put((cc) => { cc.mode = Number(v) ? 2 : 0; cc.qual = Number(v); cc.root = cc.root || 48; cc.count = 0; cc.notes = [0, 0, 0, 0, 0, 0]; })));
  rows.push(h('label', {}, 'range'), h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: c.mode === 1,
    onchange: (e) => put((cc) => { if (e.target.checked) { cc.mode = 1; cc.rstart = 21; cc.rcount = 7; } else { cc.mode = 0; cc.count = 0; cc.notes = [0, 0, 0, 0, 0, 0]; } }) }), '(M8 cluster)'));
  if (c.mode === 1) {
    rows.push(h('label', {}, 'start'), num(c.rstart, 0, 127, (v) => put((cc) => { cc.rstart = v; cc.rcount = Math.min(cc.rcount, 128 - v); })));
    rows.push(h('label', {}, 'count'), num(c.rcount, 1, 8, (v) => put((cc) => { cc.rcount = Math.min(v, 128 - cc.rstart); })));
  } else if (c.mode === 0) {
    const set = new Set(c.notes.slice(0, c.count));
    const keys = h('div', { class: 'keys' }, Array.from({ length: 24 }, (_, i) => {
      const n = 48 + i, black = [1, 3, 6, 8, 10].includes(n % 12);
      return h('button', { class: `${black ? 'black' : ''}${set.has(n) ? ' on' : ''}`, title: noteName(n),
        onclick: (e) => { e.stopPropagation(); put((cc) => {
          const s = new Set(cc.notes.slice(0, cc.count));
          if (s.has(n)) s.delete(n); else if (s.size < 5) s.add(n); else return showError('5-note max for a hand-picked set (ranges go up to 8).');
          const arr = [...s].sort((x, y) => x - y);
          cc.count = arr.length; cc.notes = [...arr, 0, 0, 0, 0, 0, 0].slice(0, 6);
        }); } }, NOTE_NAMES[n % 12].replace('#', '♯'));
    }));
    rows.push(h('label', {}, 'notes'), keys);
  }
  const summary = c.mode === 1 ? `plays range ${noteName(c.rstart)}–${noteName(c.rstart + c.rcount - 1)}`
    : c.mode === 2 ? `plays ${noteName(c.root)}${QUALITIES[c.qual] || ''}`
    : c.count ? `plays notes: ${c.notes.slice(0, c.count).map(noteName).join(' ')}` : 'no notes';
  rows.push(h('span', { class: 'summary' }, summary));
  return rows;
}

function ccValueFields(p, L, b) {
  const lay = p.layers[L];
  const cv = lay.cc_values[b] || { sub_mode: 0, on: 127, off: 0 };
  const put = (fn) => edit((q) => { const x = { sub_mode: 0, on: 127, off: 0, ...(q.layers[L].cc_values[b] || {}) }; fn(x); q.layers[L].cc_values[b] = x; });
  const rows = [h('label', { title: 'the MIDI CC number this button sends (0-127).' }, 'cc'), num(lay.button_value[b], 0, 127, (v) => edit((q) => setLayer(q, L, 'button_value', b, v))),
    h('label', {}, 'behavior'), sel(cv.sub_mode, [[0, 'Set on press'], [1, 'Momentary (hold)'], [2, 'Toggle two values']], (v) => put((x) => { x.sub_mode = Number(v); }))];
  const labels = [['value'], ['held', 'release'], ['value A', 'value B']][cv.sub_mode] || ['value'];
  rows.push(h('label', {}, labels[0]), num(cv.on, 0, 127, (v) => put((x) => { x.on = v; })));
  if (labels[1]) rows.push(h('label', {}, labels[1]), num(cv.off, 0, 127, (v) => put((x) => { x.off = v; })));
  const sum = [`press sends ${cv.on}`, `hold sends ${cv.on}, release ${cv.off}`, `presses alternate ${cv.on} / ${cv.off}, starting with ${cv.on}`][cv.sub_mode];
  rows.push(h('span', { class: 'summary' }, sum));
  return rows;
}

function keyFields(p, L, b, labelRow) {
  const lay = p.layers[L];
  if (lay.button_type[b] === 'chord') return h('div', { class: 'fields' }, labelRow, h('span', { class: 'summary' }, 'no keyboard binding (chord buttons are MIDI-only)'));
  const key = lay.button_key[b], mod = lay.button_mod[b];
  const combo = [...MODS.filter(([, bit]) => mod & bit).map(([n]) => n), KEY_BY_USAGE.get(key) || (key ? `#${key}` : '')].filter(Boolean).join('+');
  const capturing = S.capture?.b === b && S.capture?.L === L;
  return h('div', { class: 'fields' }, labelRow,
    h('label', {}, 'key'),
    h('button', { title: `click and press the key or combo this button types on layer ${L + 1}. Esc cancels. Play (the layer trigger) never types.`,
      onclick: (e) => { e.stopPropagation(); S.capture = { b, L }; render(); } },
      capturing ? 'press a key… (Esc to cancel)' : (combo || 'click, then press a key')),
    h('label', {}, 'or pick'), sel(key, KEY_CHOICES.map(([n, u]) => [u, n]), (v) => edit((q) => { q.layers[L].button_key[b] = Number(v); })),
    h('label', {}, 'mods'), h('span', { class: 'seg small' }, MODS.map(([n, bit]) =>
      h('button', { 'aria-selected': String(!!(mod & bit)), onclick: (e) => { e.stopPropagation(); edit((q) => { q.layers[L].button_mod[b] ^= bit; }); } }, n))),
    h('span', { class: 'summary' }, combo ? `types ${combo}` : 'types nothing'));
}

const ORDER = [{ kind: 'button', ix: 0 }, ...[0, 1, 2, 3].map((ix) => ({ kind: 'fader', ix })), ...[1, 2, 3, 4, 5, 6, 7, 8].map((ix) => ({ kind: 'button', ix }))];

function renderEditor() {
  const ed = $('editor'); ed.replaceChildren();
  const p = prof();
  if (!p) {
    ed.append(h('div', { class: 'panel muted' }, S.dev ? 'This slot is empty. Load a starter, import a .feldd, or Reset it to the default mapping.' : 'Connect your SP-1, try the Demo, or import a .feldd file to start.'));
    return;
  }
  if (S.pver != null && S.pver < 9) {
    ed.append(h('div', { class: 'panel' }, h('h2', {}, 'Update your SP-1'), h('p', {}, 'This firmware stores an older profile format. Export all profiles, update the firmware, then come back.'),
      h('button', { onclick: onExportAll }, 'Export all profiles')));
    return;
  }
  const L = S.layer;
  if (S.view === 'basic') {
    const i = Math.max(0, ORDER.findIndex((c) => c.kind === S.selected?.kind && c.ix === S.selected?.ix));
    const step = (d) => { S.selected = ORDER[(i + d + ORDER.length) % ORDER.length]; render(); };
    ed.append(h('div', { class: 'panel' },
      h('div', { class: 'basic-nav' }, h('button', { 'aria-label': 'previous control', onclick: () => step(-1) }, '←'),
        h('button', { 'aria-label': 'next control', onclick: () => step(1) }, '→'),
        h('span', { class: 'muted small' }, 'Pick a control on the device to edit it, or step through with the arrows.')),
      S.selected?.kind === 'fader' ? faderCard(p, L, S.selected.ix) : buttonCard(p, L, S.selected?.ix ?? 0)));
    return;
  }
  ed.append(h('section', { class: 'panel' }, h('h2', {}, 'Faders'), h('div', { class: 'cards' }, [0, 1, 2, 3].map((f) => faderCard(p, L, f)))));
  ed.append(h('section', { class: 'panel' }, h('h2', {}, S.mode === 1 ? 'Buttons (keys)' : 'Buttons'), h('div', { class: 'cards' }, [...Array(NUM_BUTTONS).keys()].map((b) => buttonCard(p, L, b)))));
}

function renderLive() {
  const p = prof();
  const labels = {};
  if (p) for (const id of CONTROL_IDS) { const t = labelOf(p, S.layer, id); if (t) labels[id] = t; }
  device.update({
    monitor: S.monitor, selected: S.selected, labels,
    // No modeLeds: feldd.com drew a fixed MIDI/Keyboard pattern there, not device
    // state, which reads as a status light that is not one (Ryan, bench 2026-10-03).
    pressed: Object.entries(S.monitor).filter(([k, v]) => k[0] === 'b' && v === 1).map(([k]) => k),
  });
  $('monitor-layer').textContent = `layer ${S.layer + 1}`;
  $('monitor-offline').hidden = !!S.dev;
  const g = $('mon-grid'); g.replaceChildren();
  if (S.dev) {
    for (let f = 0; f < 4; f++) g.append(h('div', {}, h('dt', {}, `F${f + 1}`), h('dd', {}, S.monitor[`f${f}`] ?? '-')));
    BUTTON_IDS.forEach((id, b) => g.append(h('div', {}, h('dt', {}, id), h('dd', { class: S.monitor[`b${b}`] ? 'down' : '' }, S.monitor[`b${b}`] ? 'down' : 'up'))));
  }
  // Light the matching cards without rebuilding the editor.
  document.querySelectorAll('.card[data-ctl]').forEach((c) => {
    const k = c.dataset.ctl;
    c.classList.toggle('live', k[0] === 'b' && S.monitor[k] === 1);
    c.classList.toggle('sel', S.selected && `${S.selected.kind[0]}${S.selected.ix}` === k);
    const bar = c.querySelector('.livebar span');
    if (bar) bar.style.width = `${typeof S.monitor[k] === 'number' ? (S.monitor[k] / 127) * 100 : 0}%`;
  });
}

function renderLog() {
  $('log-count').textContent = `· ${S.log.length}`;
  const pre = $('log');
  pre.hidden = !S.logOpen;
  $('log-toggle').textContent = S.logOpen ? 'hide' : 'show';
  if (S.logOpen) { pre.textContent = S.log.length ? S.log.join('\n') : 'no traffic yet — connect to see frames'; pre.scrollTop = pre.scrollHeight; }
}

// ------------------------------------------------------------------ banners --

function showError(e) { const el = $('error'); el.textContent = e?.message || String(e); el.hidden = false; }
function clearError() { $('error').hidden = true; }
function showBanner(t) { const el = $('banner'); el.textContent = t; el.hidden = false; }
function hideBanner() { $('banner').hidden = true; $('banner').textContent = ''; }

// -------------------------------------------------------------------- wiring --

function wire() {
  device = createSp1Device($('device'), { onSelect: (s) => { S.selected = s; if (S.view === 'basic') render(); else { renderLive(); document.querySelector(`.card[data-ctl="${s.kind[0]}${s.ix}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } } });
  $('btn-connect').onclick = () => connect(false);
  $('btn-demo').onclick = () => connect(true);
  $('btn-disconnect').onclick = disconnect;
  $('btn-theme').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('sp1cfg-theme', document.documentElement.dataset.theme); } catch {}
  };
  try { const t = localStorage.getItem('sp1cfg-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  document.querySelectorAll('#mode-tabs button').forEach((b) => { b.onclick = () => selectMode(Number(b.dataset.mode)); });
  document.querySelectorAll('#view-tabs button').forEach((b) => { b.onclick = () => { S.view = b.dataset.v; render(); }; });
  $('btn-dup').onclick = onDuplicate;
  $('btn-reset').onclick = onReset;
  $('btn-export').onclick = () => { try { onExport(); } catch (e) { showError(e); } };
  $('btn-export-all').onclick = () => { try { onExportAll(); } catch (e) { showError(e); } };
  $('btn-import').onclick = () => $('file-import').click();
  $('file-import').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onImportFile(f); };
  $('btn-save').onclick = onSave;
  $('btn-save-all').onclick = onSaveAll;
  $('all-ch').onchange = (e) => {
    const ch = clamp(e.target.value, 1, 16) - 1;
    edit((p) => {
      p.channel = ch;
      for (let L = 0; L < NUM_LAYERS; L++) {
        for (let f = 0; f < NUM_FADERS; f++) setLayer(p, L, 'fader_channel', f, ch);
        for (let b = 0; b < NUM_BUTTONS; b++) setLayer(p, L, 'button_channel', b, ch);
      }
    });
  };
  $('starter').onchange = (e) => { loadStarter(e.target.value); e.target.value = ''; };
  $('af-dir').onchange = (e) => { if (!$('af-start').dataset.touched) $('af-start').value = e.target.value === 'down' ? 127 : 0; };
  $('af-start').oninput = (e) => { e.target.dataset.touched = '1'; };
  $('af-fill').onclick = autofill;
  const thru = (id, setter, key) => document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.onclick = async () => {
      if (!S.dev) return;
      try { S[key] = await S.dev[setter](Number(b.dataset.v)); } catch (e) { showError(e); }
      render();
    };
  });
  thru('thru-trs', 'setMidiThru', 'midithru');
  thru('thru-ble', 'setBleThru', 'blethru');
  $('log-toggle').onclick = () => { S.logOpen = !S.logOpen; renderLog(); };
  $('log-clear').onclick = () => { S.log = []; renderLog(); };
  $('log-copy').onclick = () => navigator.clipboard?.writeText(S.log.join('\n'));
  window.addEventListener('keydown', (e) => {
    if (!S.capture) return;
    e.preventDefault();
    const { b, L } = S.capture;
    if (e.code === 'Escape') { S.capture = null; render(); return; }
    const usage = CODE_TO_USAGE[e.code];
    if (!usage) return; // modifier-only or unsupported: keep waiting
    const mod = (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    S.capture = null;
    edit((q) => { q.layers[L].button_key[b] = usage; q.layers[L].button_mod[b] = mod; });
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.banks.some((bank) => bank.some(isDirty))) { e.preventDefault(); e.returnValue = ''; }
  });
  if (/Mobi|Android|iPhone|iPod/i.test(navigator.userAgent)) showBanner('This configurator needs a computer: the SP-1 connects over USB with WebSerial.');
  let lastAcross = null;
  window.addEventListener('resize', () => {
    const across = $('jack-panel').clientWidth >= 600;
    if (across !== lastAcross) { lastAcross = across; renderJack(); }
  });
  if (new URLSearchParams(location.search).get('demo') === '1') connect(true);
}

wire();
render();
