// Readable port of feldd.com's profile codec, with the v10 jack tail.
export const NUM_LAYERS = 8, NUM_FADERS = 4, NUM_BUTTONS = 9;
export const PROFILE_VERSION = 10, PBYTES_V9 = 1038, PBYTES_V10 = 1065;
export const NAME_LEN = 16, MAX_CHORD = 8, MAX_EXPLICIT = 5;
export const CLOCK_FADER_NONE = 7, CLOCK_TAP_NONE = 15;
const CURVES = ['linear', 'log', 'exp'];
const TYPES = ['none', 'note', 'cc_toggle', 'cc_momentary', 'transport', 'profile_switch', 'chord', 'cc_value'];
export class ProfileError extends Error {
  constructor(message) { super(message); this.name = 'ProfileError'; }
}
const clamp = (value, min, max) => value < min ? min : value > max ? max : value;
function integer(name, value, min, max) {
  if (!Number.isInteger(value)) throw new ProfileError(`${name} must be an integer, got ${String(value)}`);
  if (value < min || value > max) throw new ProfileError(`${name} out of range (${min}..${max}): ${value}`);
  return value;
}
function enumByte(name, value, choices) {
  const index = choices.indexOf(value);
  if (index < 0) throw new ProfileError(`${name} unknown: ${String(value)}`);
  return index;
}
function enumValue(name, value, choices) {
  if (choices[value] === undefined) throw new ProfileError(`${name} byte invalid: ${value}`);
  return choices[value];
}
function booleanByte(name, value) {
  if (typeof value !== 'boolean') throw new ProfileError(`${name} must be boolean`);
  return +value;
}
export const JACK_DEFAULTS = Object.freeze({
  mode: 0, width: 100,
  trigger_note: Object.freeze(Array(8).fill(51)),
  trigger_channel: Object.freeze(Array(8).fill(0)),
  sync_div: Object.freeze(Array(8).fill(12)),
});
export const createDefaultJack = () => structuredClone(JACK_DEFAULTS);
export function pickEncodeVersion(hello) {
  // Unknown devices retain the old site's v9 fallback. Never down-encode to v1–8.
  return typeof hello?.pver === 'number' && hello.pver >= 10 ? 10 : 9;
}
export function createDefaultChord() {
  return {mode: 0, count: 0, notes: Array(6).fill(0), root: 0, qual: 0, rstart: 0, rcount: 0};
}
export function createDefaultLayer() {
  return {
    fader_cc: Array(4).fill(0), fader_min: Array(4).fill(0), fader_max: Array(4).fill(0),
    fader_curve: Array(4).fill('linear'), fader_invert: Array(4).fill(false), fader_channel: Array(4).fill(0),
    button_type: Array(9).fill('none'), button_value: Array(9).fill(0), button_channel: Array(9).fill(0),
    button_key: Array(9).fill(0), button_mod: Array(9).fill(0), button_chord_ix: Array(9).fill(0),
    fader_role: Array(4).fill(0),
  };
}
function migrateChord(chord) {
  if (!chord) return createDefaultChord();
  return {...createDefaultChord(), ...chord, count: Math.min(chord.count ?? 0, 5),
    notes: [...(chord.notes ?? []).slice(0, 5), 0, 0, 0, 0, 0, 0].slice(0, 6)};
}
function encodeChord(chord = createDefaultChord()) {
  const bytes = new Uint8Array(6);
  const mode = integer('chord6.mode', chord.mode ?? 0, 0, 2);
  if (mode === 0) {
    bytes[0] = Math.min(chord.count ?? 0, 5) & 31;
    for (let i = 0; i < 5; i++) bytes[i + 1] = integer(`chord6.notes[${i}]`, chord.notes?.[i] ?? 0, 0, 127);
  } else if (mode === 1) {
    bytes[0] = 32;
    bytes[1] = integer('chord6.rstart', chord.rstart ?? 0, 0, 127);
    bytes[2] = integer('chord6.rcount', chord.rcount ?? 0, 0, 8);
    if (bytes[2] > 0 && bytes[1] + bytes[2] - 1 > 127) throw new ProfileError('chord6 range overflows 127');
  } else {
    bytes[0] = 64;
    bytes[1] = integer('chord6.root', chord.root ?? 0, 0, 127);
    bytes[2] = integer('chord6.qual', chord.qual ?? 0, 0, 9);
  }
  return bytes;
}
function decodeChord(bytes) {
  const chord = createDefaultChord();
  chord.mode = clamp((bytes[0] >> 5) & 7, 0, 2);
  if (chord.mode === 1) {
    chord.rstart = clamp(bytes[1] ?? 0, 0, 127); chord.rcount = clamp(bytes[2] ?? 0, 0, 8);
  } else if (chord.mode === 2) {
    chord.root = clamp(bytes[1] ?? 0, 0, 127); chord.qual = clamp(bytes[2] ?? 0, 0, 9);
  } else {
    chord.count = clamp(bytes[0] & 31, 0, 5);
    for (let i = 0; i < 5; i++) chord.notes[i] = clamp(bytes[i + 1] ?? 0, 0, 127);
  }
  return chord;
}
function validateJack(jack) {
  integer('jack.mode', jack.mode, 0, 2);
  integer('jack.width', jack.width, 1, 255);
  for (const [key, min, max] of [['trigger_note', 0, 127], ['trigger_channel', 0, 16], ['sync_div', 1, 24]]) {
    if (!Array.isArray(jack[key]) || jack[key].length !== 8) throw new ProfileError(`jack.${key} must have exactly 8 entries`);
    jack[key].forEach((value, i) => integer(`jack.${key}[${i}]`, value, min, max));
  }
}
const FADER_FIELDS = ['fader_cc', 'fader_min', 'fader_max', 'fader_curve', 'fader_invert', 'fader_channel'];
const BUTTON_FIELDS = ['button_type', 'button_value', 'button_channel', 'button_key', 'button_mod'];
export function encodeProfile(profile, version = 10) {
  if (profile == null || typeof profile !== 'object') throw new ProfileError('profile must be an object');
  if (version !== 9 && version !== 10) throw new ProfileError(`unsupported encode version ${version}`);
  const sourceVersion = profile.version ?? 9;
  if (sourceVersion < 1 || sourceVersion > 10) throw new ProfileError(`unsupported profile version ${sourceVersion} (expected 1..10)`);
  const channel = integer('channel', profile.channel ?? 0, 0, 15);
  const faders = profile.faders ?? [], buttons = profile.buttons ?? [];
  if (faders.length !== 4) throw new ProfileError('faders must have exactly 4 entries');
  if (buttons.length !== 9) throw new ProfileError('buttons must have exactly 9 entries');
  const layers = Array.from({length: 8}, (_, layerIndex) => {
    // Unlike the bundle, normalization does not mutate the caller's profile.
    const layer = {...(profile.layers?.[layerIndex] ?? createDefaultLayer())};
    layer.fader_role ??= Array(4).fill(0);
    layer.button_chord_ix ??= Array(9).fill(0);
    layer.chords ??= Array.from({length: 9}, (_, button) => migrateChord(profile.chord_table?.[(layer.button_chord_ix[button] ?? 0) - 1]));
    for (const [fields, count] of [[FADER_FIELDS, 4], [BUTTON_FIELDS, 9]]) {
      if (fields.some(key => layer[key]?.length !== count)) throw new ProfileError(`layers[${layerIndex}] arrays must each have ${count} entries`);
    }
    return layer;
  });
  const bytes = new Uint8Array(version === 10 ? PBYTES_V10 : PBYTES_V9);
  let offset = 0;
  const put = value => { bytes[offset++] = value; };
  const array = (layer, key, max) => layers[layer][key].forEach((value, i) => put(integer(`layers[${layer}].${key}[${i}]`, value, 0, max)));
  put(version); put(channel);
  // The original codec takes CC/value from layer 0, other base fields from top-level controls.
  faders.forEach((fader, i) => {
    put(integer(`faders[${i}].cc`, layers[0].fader_cc[i], 0, 127));
    put(integer(`faders[${i}].min`, fader.min, 0, 127));
    put(integer(`faders[${i}].max`, fader.max, 0, 127));
    put(enumByte('fader.curve', fader.curve, CURVES)); put(booleanByte('fader.invert', fader.invert));
  });
  buttons.forEach((button, i) => {
    put(enumByte('button.type', button.type, TYPES)); put(integer(`buttons[${i}].value`, layers[0].button_value[i], 0, 127));
  });
  array(1, 'fader_cc', 127); array(1, 'button_value', 127);
  const name = new TextEncoder().encode(profile.name ?? '');
  if (name.length > 16) throw new ProfileError(`name too long (${name.length} > 16 bytes)`);
  bytes.set(name, offset); offset += 16;
  faders.forEach(fader => put(integer('fader.channel', fader.channel ?? channel, 0, 15)));
  buttons.forEach(button => put(integer('button.channel', button.channel ?? channel, 0, 15)));
  for (let layer = 0; layer < 8; layer++) {
    if (layer >= 2) { array(layer, 'fader_cc', 127); array(layer, 'button_value', 127); }
    array(layer, 'button_key', 255); array(layer, 'button_mod', 255);
  }
  for (let layer = 1; layer < 8; layer++) {
    array(layer, 'fader_min', 127); array(layer, 'fader_max', 127);
    layers[layer].fader_curve.forEach(value => put(enumByte('fader_curve', value, CURVES)));
    layers[layer].fader_invert.forEach(value => put(booleanByte('fader_invert', value)));
    layers[layer].button_type.forEach(value => put(enumByte('button_type', value, TYPES)));
    array(layer, 'fader_channel', 15); array(layer, 'button_channel', 15);
  }
  for (let layer = 0; layer < 8; layer++) for (let button = 0; button < 9; button++) {
    const type = layer === 0 ? buttons[button].type : layers[layer].button_type[button];
    if (type === 'cc_value') {
      const value = layers[layer].cc_values?.[button] ?? {};
      bytes.set([0, integer('cc_value.on', value.on ?? 0, 0, 127), integer('cc_value.off', value.off ?? 0, 0, 127), integer('cc_value.sub_mode', value.sub_mode ?? 0, 0, 2), 0, 0], offset);
    } else bytes.set(encodeChord(layers[layer].chords[button]), offset);
    offset += 6;
  }
  for (let layer = 0; layer < 8; layer++) for (let i = 0; i < 4; i++) put(integer('fader_role', layers[layer].fader_role[i] ?? 0, 0, 1));
  put(integer('chord_velocity', profile.chord_velocity ?? 100, 0, 127));
  put(clamp(profile.shiftTarget ?? 0, 0, 7));
  const clock = profile.clock;
  put(clock ? (128 * !!clock.enable | (clock.tapButton & 15) << 3 | clock.bpmFader & 7) & 255 : 0);
  put(clock ? clamp(clock.defaultBpm, 0, 240) : 0);
  if (version === 10) {
    const jack = profile.jack ?? createDefaultJack(); validateJack(jack);
    put(jack.mode); put(jack.width);
    for (const key of ['trigger_note', 'trigger_channel', 'sync_div']) jack[key].forEach(put);
    put(0);
  }
  if (offset !== bytes.length) throw new ProfileError(`internal: encoded ${offset} bytes, expected ${bytes.length}`);
  return bytes;
}

export function decodeProfile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v10 = bytes.length === PBYTES_V10;
  const current = v10 || bytes.length === PBYTES_V9;
  if (bytes.length > PBYTES_V9 && !v10) throw new ProfileError(`unsupported profile length: ${bytes.length}`);
  if (v10 && bytes[0] !== 10) throw new ProfileError('v10 length requires version byte 10');
  if (v10 && bytes[1064] !== 0) throw new ProfileError('reserved byte 1064 must be zero');
  if (bytes.length < 69) throw new ProfileError(`profile blob too short: ${bytes.length} < 69`);
  let offset = 0;
  const get = (max = 255) => clamp(bytes[offset++], 0, max);
  const sourceVersion = get(), channel = get(15);
  const layers = Array.from({length: 8}, createDefaultLayer);
  const faders = [], buttons = [];
  const inheritedLayers = current ? 1 : 4;
  for (let i = 0; i < 4; i++) {
    const cc = get(127), min = get(127), max = get(127);
    const curve = enumValue('fader.curve', get(), CURVES), invert = get() !== 0;
    faders.push({cc, min, max, curve, invert, channel});
    layers[0].fader_cc[i] = cc;
    for (let layer = 0; layer < inheritedLayers; layer++) {
      for (const [key, value] of Object.entries({min, max, curve, invert, channel})) layers[layer][`fader_${key}`][i] = value;
    }
  }
  for (let i = 0; i < 9; i++) {
    const type = enumValue('button.type', get(), TYPES), value = get(127);
    buttons.push({type, value, channel}); layers[0].button_value[i] = value;
    for (let layer = 0; layer < inheritedLayers; layer++) {
      layers[layer].button_type[i] = type; layers[layer].button_channel[i] = channel;
    }
  }
  const array = (layer, key, count, max = 255) => { layers[layer][key] = Array.from({length: count}, () => get(max)); };
  array(1, 'fader_cc', 4, 127); array(1, 'button_value', 9, 127);
  const nameBytes = bytes.subarray(offset, offset + 16); offset += 16;
  const zero = nameBytes.indexOf(0);
  const name = new TextDecoder().decode(nameBytes.subarray(0, zero < 0 ? 16 : zero));
  if (bytes.length >= 82) {
    for (const [controls, key] of [[faders, 'fader_channel'], [buttons, 'button_channel']]) {
      controls.forEach((control, i) => {
        control.channel = get(15);
        for (let layer = 0; layer < inheritedLayers; layer++) layers[layer][key][i] = control.channel;
      });
    }
  }
  if (bytes.length >= 100) { array(0, 'button_key', 9); array(0, 'button_mod', 9); }
  if (bytes.length >= 118) { array(1, 'button_key', 9); array(1, 'button_mod', 9); }
  if (bytes.length >= 180) for (let layer = 2; layer < (current ? 8 : 4); layer++) {
    array(layer, 'fader_cc', 4, 127); array(layer, 'button_value', 9, 127);
    array(layer, 'button_key', 9); array(layer, 'button_mod', 9);
  }
  if (bytes.length >= 294) for (let layer = 1; layer < (current ? 8 : 4); layer++) {
    array(layer, 'fader_min', 4, 127); array(layer, 'fader_max', 4, 127);
    layers[layer].fader_curve = Array.from({length: 4}, () => enumValue('fader_curve', get(), CURVES));
    layers[layer].fader_invert = Array.from({length: 4}, () => get() !== 0);
    layers[layer].button_type = Array.from({length: 9}, () => enumValue('button_type', get(), TYPES));
    array(layer, 'fader_channel', 4, 15); array(layer, 'button_channel', 9, 15);
  }
  const chord_table = Array.from({length: 8}, createDefaultChord);
  let chord_velocity = 100;
  for (let layer = 0; layer < (current ? 8 : 4); layer++) layers[layer].chords = Array.from({length: 9}, createDefaultChord);
  if (!current && bytes.length >= 444 && bytes.length < 528) {
    for (let layer = 0; layer < 4; layer++) array(layer, 'button_chord_ix', 9, 8);
    for (let i = 0; i < 8; i++) chord_table[i] = {
      mode: get(2), count: get(6), notes: Array.from({length: 6}, () => get(127)),
      root: get(127), qual: get(9), rstart: get(127), rcount: get(127),
    };
    for (let layer = 0; layer < 4; layer++) array(layer, 'fader_role', 4, 1);
    chord_velocity = get(127); offset++;
    for (let layer = 0; layer < 4; layer++) for (let button = 0; button < 9; button++) {
      const index = layers[layer].button_chord_ix[button];
      if (index > 0) layers[layer].chords[button] = migrateChord(chord_table[index - 1]);
    }
  }
  if (current || bytes.length >= 528) {
    offset = current ? 570 : 294;
    for (let layer = 0; layer < (current ? 8 : 4); layer++) {
      if (current) { layers[layer].chords = []; layers[layer].cc_values = []; }
      for (let button = 0; button < 9; button++) {
        const payload = bytes.subarray(offset, offset + 6); offset += 6;
        if (current && layers[layer].button_type[button] === 'cc_value') {
          layers[layer].cc_values[button] = {sub_mode: clamp(payload[3] ?? 0, 0, 2), on: clamp(payload[1] ?? 0, 0, 127), off: clamp(payload[2] ?? 0, 0, 127)};
        } else layers[layer].chords[button] = decodeChord(payload);
      }
    }
    for (let layer = 0; layer < (current ? 8 : 4); layer++) array(layer, 'fader_role', 4, 1);
    chord_velocity = get(127);
  }
  const profile = {format: 'sp1-profile', version: current ? 10 : sourceVersion, name, channel, faders, buttons, layers, chord_table, chord_velocity};
  if (current) {
    profile.shiftTarget = get(7);
    const packed = get(), bpm = get();
    if (packed !== 0 || bpm !== 0) profile.clock = {enable: (packed & 128) !== 0, tapButton: (packed >> 3) & 15, bpmFader: packed & 7, defaultBpm: bpm};
    profile.jack = v10 ? {
      mode: bytes[1038], width: bytes[1039], trigger_note: Array.from(bytes.slice(1040, 1048)),
      trigger_channel: Array.from(bytes.slice(1048, 1056)), sync_div: Array.from(bytes.slice(1056, 1064)),
    } : createDefaultJack();
    validateJack(profile.jack);
  }
  return profile;
}
export function fromBase64(text) {
  const binary = globalThis.atob(text.replace(/\s+/g, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}
export const profileFromBase64 = text => decodeProfile(fromBase64(text));
export const profileToBase64 = (profile, version = 10) => toBase64(encodeProfile(profile, version));

// File-only labels, ported from feldd.com's configurator.
export const CONTROL_IDS = ['F1', 'F2', 'F3', 'F4', 'Play', 'T1', 'T2', 'T3', 'T4', 'Vol+', 'Vol-', 'FWD', 'RWD'];
export const LABEL_MAX_LEN = 24, NUM_LABEL_LAYERS = 8;
export const allLayers = labels => Array.from({length: 8}, () => ({...labels}));
export function faderControlId(index) {
  const id = CONTROL_IDS.slice(0, 4)[index];
  if (!id) throw new Error(`fader index out of range (0..3): ${index}`);
  return id;
}
export function buttonControlId(index) {
  const id = CONTROL_IDS.slice(4)[index];
  if (!id) throw new Error(`button index out of range (0..8): ${index}`);
  return id;
}
function normalizeLabels(input) {
  if (input == null || typeof input !== 'object') return;
  const labels = {};
  for (const [key, value] of Object.entries(input)) {
    if (!CONTROL_IDS.includes(key) || typeof value !== 'string') continue;
    const label = value.trim().slice(0, 24);
    if (label) labels[key] = label;
  }
  return Object.keys(labels).length ? labels : undefined;
}
export function normalizeLayerLabels(input) {
  if (Array.isArray(input)) {
    const labels = input.slice(0, 8).map(layer => normalizeLabels(layer) ?? {});
    while (labels.length && !Object.keys(labels.at(-1)).length) labels.pop();
    return labels.length ? labels : undefined;
  }
  const labels = normalizeLabels(input);
  return labels ? allLayers(labels) : undefined;
}

// JSON file helpers, ported from feldd.com's configurator.
export const BUNDLE_FORMAT = 'sp1-bundle';
function parseJSON(text) {
  try { return JSON.parse(text); } catch { throw new ProfileError('not valid JSON'); }
}
export function parseProfile(text) {
  const profile = parseJSON(text);
  if (profile == null || typeof profile !== 'object') throw new ProfileError('profile file must be a JSON object');
  if (profile.format !== 'sp1-profile') throw new ProfileError(`expected format "sp1-profile", got ${String(profile.format)}`);
  const normalized = decodeProfile(encodeProfile(profile));
  const labels = normalizeLayerLabels(profile.labels);
  return labels ? {...normalized, labels} : normalized;
}
function normalizeBundle(bundle) {
  if (bundle == null || typeof bundle !== 'object') throw new ProfileError('bundle file must be a JSON object');
  if (bundle.format !== BUNDLE_FORMAT) throw new ProfileError(`expected a full-device backup (format "${BUNDLE_FORMAT}"), got ${String(bundle.format)}`);
  if (!Array.isArray(bundle.profiles)) throw new ProfileError('bundle must hold a profiles array');
  const seen = new Set();
  return {format: BUNDLE_FORMAT, version: 1, profiles: bundle.profiles.map((entry, index) => {
    if (entry == null || typeof entry !== 'object') throw new ProfileError(`bundle entry ${index} must be an object`);
    if (entry.mode !== 'midi' && entry.mode !== 'keyboard') throw new ProfileError(`bundle entry ${index} has an invalid mode ${String(entry.mode)} (expected "midi" or "keyboard")`);
    if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= 8) throw new ProfileError(`bundle entry ${index} has an out-of-range slot ${String(entry.slot)} (expected 0..7)`);
    if (entry.profile == null || typeof entry.profile !== 'object') throw new ProfileError(`bundle entry ${index} is missing a profile`);
    const key = `${entry.mode}:${entry.slot}`;
    if (seen.has(key)) throw new ProfileError(`bundle has a duplicate entry for ${key}`);
    seen.add(key);
    // Source bundle imports/exports discard labels during binary normalization.
    return {mode: entry.mode, slot: entry.slot, profile: decodeProfile(encodeProfile(entry.profile))};
  })};
}
export const parseBundle = text => normalizeBundle(parseJSON(text));
export const encodeBundle = bundle => JSON.stringify(normalizeBundle(bundle), null, 2);
