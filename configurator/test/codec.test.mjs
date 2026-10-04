import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeProfile, decodeProfile, fromBase64, toBase64,
  profileFromBase64, profileToBase64,
  JACK_DEFAULTS, createDefaultJack, pickEncodeVersion,
} from '../web/codec.js';

const configuratorDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const firmwareDir = resolve(configuratorDir, process.env.FELDD_TREE ?? '../firmware');
const fixturePath = resolve(firmwareDir, 'test/test_profile.c');
const firmwareTests = readFileSync(fixturePath, 'utf8');

// Join C continuation lines, then concatenate adjacent C string literals.
// The fixture bytes always come from the firmware, never a JS copy.
function readGolden(name) {
  const logicalLines = firmwareTests.replace(/\\\r?\n/g, '');
  const definition = logicalLines.match(new RegExp(`^\\s*#define\\s+${name}\\s+([^\\r\\n]+)`, 'm'));
  assert.ok(definition, `${name} missing from ${fixturePath}`);
  const literals = [...definition[1].matchAll(/"(?:\\.|[^"\\])*"/g)];
  assert.ok(literals.length, `${name} must contain C string literals`);
  return literals.map(([literal]) => JSON.parse(literal)).join('');
}

const goldens = Object.fromEntries([
  'PARITY_V9_B64', 'PARITY_V10_B64', 'PARITY_V9_CCVAL_B64',
  'PARITY_V9_SHIFT_B64', 'PARITY_V8_LEGACY_SRC_B64', 'PARITY_V8_LEGACY_B64',
].map(name => [name, readGolden(name)]));

const expectedJack = {
  mode: 0, width: 100,
  trigger_note: Array(8).fill(51),
  trigger_channel: Array(8).fill(0),
  sync_div: Array(8).fill(12),
};
const profile = () => decodeProfile(fromBase64(goldens.PARITY_V10_B64));

for (const name of Object.keys(goldens).filter(name => name !== 'PARITY_V8_LEGACY_SRC_B64')) {
  test(`${name}: firmware bytes survive decode and encode`, () => {
    const bytes = fromBase64(goldens[name]);
    // Several historical V9 names now contain v10 fixtures in test_profile.c.
    assert.ok(bytes[0] === 9 || bytes[0] === 10);
    assert.equal(toBase64(encodeProfile(decodeProfile(bytes), bytes[0])), goldens[name]);
  });
}

test('parity fixture retains every layer, keymap, enum, channel and fader property', () => {
  const p = profile();
  assert.equal(p.format, 'sp1-profile');
  assert.equal(p.name, 'OP-XY 8layer');
  assert.equal(p.channel, 5);
  assert.equal(p.layers.length, 8);
  const curves = ['linear', 'log', 'exp'];
  const types = ['none', 'note', 'cc_toggle', 'cc_momentary', 'transport', 'profile_switch'];
  for (let layer = 0; layer < 8; layer++) {
    const actual = p.layers[layer];
    for (let i = 0; i < 4; i++) {
      assert.equal(actual.fader_cc[i], 10 + layer * 4 + i);
      assert.equal(actual.fader_min[i], layer + i);
      assert.equal(actual.fader_max[i], 100 + layer + i);
      assert.equal(actual.fader_curve[i], curves[(layer + i) % 3]);
      assert.equal(actual.fader_invert[i], Boolean((layer + i) % 2));
      assert.equal(actual.fader_channel[i], (layer + i) & 15);
      assert.equal(actual.fader_role[i], Number(i === layer % 4));
    }
    for (let i = 0; i < 9; i++) {
      assert.equal(actual.button_type[i], types[(layer + i) % 6]);
      assert.equal(actual.button_value[i], 20 + layer * 9 + i);
      assert.equal(actual.button_channel[i], (layer + i + 1) & 15);
      assert.equal(actual.button_key[i], 4 + layer * 3 + i);
      assert.equal(actual.button_mod[i], (layer + i) & 15);
    }
  }
  assert.equal(p.chord_velocity, 100);
});

test('packed explicit, range and root/quality chords retain their independent layer slots', () => {
  const { layers } = profile();
  assert.equal(layers[0].chords[1].count, 3);
  assert.deepEqual(layers[0].chords[1].notes.slice(0, 3), [60, 64, 67]);
  assert.equal(layers[1].chords[2].mode, 1);
  assert.equal(layers[1].chords[2].rstart, 21);
  assert.equal(layers[1].chords[2].rcount, 7);
  assert.equal(layers[2].chords[3].mode, 2);
  assert.equal(layers[2].chords[3].root, 48);
  assert.equal(layers[2].chords[3].qual, 5);
  assert.deepEqual(layers[5].chords[4].notes.slice(0, 3), [36, 40, 43]);
});

test('CC-value fixture preserves payloads without colliding with chords on other layers', () => {
  const p = profileFromBase64(goldens.PARITY_V9_CCVAL_B64);
  assert.equal(p.buttons[3].type, 'cc_value');
  assert.equal(p.layers[3].button_type[4], 'cc_value');
  assert.deepEqual(p.layers[0].cc_values[3], { on: 9, off: 45, sub_mode: 0 });
  assert.deepEqual(p.layers[3].cc_values[4], { on: 9, off: 45, sub_mode: 2 });
  assert.equal(p.layers[2].chords[3].mode, 2);
  assert.deepEqual(p.layers[5].chords[4].notes.slice(0, 3), [36, 40, 43]);
});

test('shift-target fixture preserves byte 1035', () => {
  const p = profileFromBase64(goldens.PARITY_V9_SHIFT_B64);
  assert.equal(p.shiftTarget, 3);
  assert.equal(encodeProfile(p, 10)[1035], 3);
});

test('v8 legacy source upgrades to the firmware hand-authored current golden', () => {
  const source = fromBase64(goldens.PARITY_V8_LEGACY_SRC_B64);
  assert.equal(source.length, 528);
  assert.equal(source[0], 8);
  const p = decodeProfile(source);
  assert.equal(p.name, 'OP-XY mix');
  assert.equal(p.faders[0].cc, 7);
  assert.equal(p.layers[2].fader_cc[0], 40);
  assert.equal(p.layers[3].fader_cc[0], 50);
  assert.equal(p.layers[1].fader_min[1], 5);
  for (const layer of p.layers.slice(4)) {
    assert.deepEqual(layer.fader_cc, [0, 0, 0, 0]);
    assert.deepEqual(layer.fader_min, [0, 0, 0, 0]);
    assert.deepEqual(layer.fader_role, [0, 0, 0, 0]);
  }
  const expected = fromBase64(goldens.PARITY_V8_LEGACY_B64);
  assert.equal(toBase64(encodeProfile(p, expected[0])), goldens.PARITY_V8_LEGACY_B64);
});

test('v10 is 1065 bytes / 1420 base64 characters without padding, with zero reserved byte', () => {
  const bytes = encodeProfile(profile(), 10);
  assert.equal(bytes.length, 1065);
  assert.equal(bytes[0], 10);
  assert.equal(bytes[1064], 0);
  assert.equal(toBase64(bytes).length, 1420);
  assert.ok(!toBase64(bytes).includes('='));
  assert.deepEqual(decodeProfile(bytes).jack, expectedJack);
});

test('v9 receives jack defaults and upgrades exactly to the firmware v10 golden', () => {
  const v9 = fromBase64(goldens.PARITY_V9_B64);
  assert.equal(v9.length, 1038);
  assert.equal(goldens.PARITY_V9_B64.length, 1384);
  const upgraded = decodeProfile(v9);
  assert.deepEqual(upgraded.jack, expectedJack);
  const v10 = encodeProfile(upgraded, 10);
  // Section 8's prefix claim excludes byte 0: the version must change to 10.
  assert.equal(v9[0], 9);
  assert.equal(v10[0], 10);
  assert.deepEqual(v10.slice(1, 1038), v9.slice(1));
  assert.equal(toBase64(v10), goldens.PARITY_V10_B64);
});

test('v9 encoding omits a non-default jack without mutating the profile', () => {
  const p = profile();
  p.jack.mode = 2;
  p.jack.width = 255;
  const before = structuredClone(p);
  assert.equal(toBase64(encodeProfile(p, 9)), goldens.PARITY_V9_B64);
  assert.deepEqual(p, before);
});

test('jack defaults are exported and independently allocated', () => {
  assert.deepEqual(JACK_DEFAULTS, expectedJack);
  const first = createDefaultJack();
  const second = createDefaultJack();
  first.trigger_note[0] = 90;
  assert.deepEqual(second, expectedJack);
  assert.deepEqual(JACK_DEFAULTS, expectedJack);
});

test('non-default jack fields round-trip at their boundaries on all eight layers', () => {
  const p = profile();
  p.jack = {
    mode: 2, width: 255,
    trigger_note: [0, 127, 1, 126, 2, 125, 3, 124],
    trigger_channel: [0, 16, 1, 15, 2, 14, 3, 13],
    sync_div: [1, 24, 2, 23, 3, 22, 4, 21],
  };
  assert.deepEqual(decodeProfile(encodeProfile(p, 10)).jack, p.jack);
  p.jack.mode = 1;
  p.jack.width = 1;
  assert.deepEqual(decodeProfile(encodeProfile(p, 10)).jack, p.jack);
});

for (const [field, value, offset] of [
  ['mode', 3, 1038], ['width', 0, 1039],
  ['trigger_note', 128, 1040], ['trigger_channel', 17, 1048],
  ['sync_div', 0, 1056], ['sync_div', 25, 1056],
]) {
  test(`encode and decode reject jack ${field} = ${value}`, () => {
    const p = profile();
    if (Array.isArray(p.jack[field])) p.jack[field][0] = value;
    else p.jack[field] = value;
    assert.throws(() => encodeProfile(p, 10));
    const bytes = fromBase64(goldens.PARITY_V10_B64);
    bytes[offset] = value;
    assert.throws(() => decodeProfile(bytes));
  });
}

test('jack encoding rejects fractional values, negative values and wrong array lengths', () => {
  for (const change of [
    p => { p.jack.width = 1.5; },
    p => { p.jack.width = 256; },
    p => { p.jack.mode = -1; },
    p => { p.jack.trigger_note[7] = -1; },
    p => { p.jack.trigger_channel[7] = 0.5; },
    p => { p.jack.sync_div.pop(); },
    p => { p.jack.trigger_note.push(1); },
  ]) {
    const p = profile();
    change(p);
    assert.throws(() => encodeProfile(p, 10));
  }
});

test('reserved byte 1064 must be zero', () => {
  const bytes = fromBase64(goldens.PARITY_V10_B64);
  bytes[1064] = 1;
  assert.throws(() => decodeProfile(bytes));
});

test('a 1065-byte blob stamped v9 is rejected instead of entering the legacy decoder', () => {
  const bytes = fromBase64(goldens.PARITY_V10_B64);
  bytes[0] = 9;
  assert.throws(() => decodeProfile(bytes));
});

test('unknown lengths above 1038, including 1100, are rejected', () => {
  for (const size of [1039, 1064, 1066, 1100]) {
    const bytes = new Uint8Array(size);
    bytes[0] = 10;
    assert.throws(() => decodeProfile(bytes));
  }
});

test('legacy layout boundaries and permissive sizes below 1038 remain readable', () => {
  for (const size of [69, 82, 100, 118, 180, 294, 444, 528, 529, 1037]) {
    const bytes = new Uint8Array(size);
    bytes[0] = 1;
    const decoded = decodeProfile(bytes);
    assert.equal(decoded.format, 'sp1-profile');
    assert.equal(decoded.layers.length, 8);
    assert.equal(encodeProfile(decoded, 9).length, 1038);
  }
  assert.throws(() => decodeProfile(new Uint8Array(68)));
});

test('base64 helpers accept whitespace and preserve firmware bytes', () => {
  const base64 = goldens.PARITY_V10_B64;
  const spaced = ` \n${base64.slice(0, 100)}\r\n\t${base64.slice(100)} `;
  assert.equal(toBase64(fromBase64(spaced)), base64);
  assert.equal(profileToBase64(profileFromBase64(spaced), 10), base64);
});

test('clock packing retains enabled state, selectors, BPM and neighboring fields', () => {
  const p = profile();
  assert.equal(p.clock, undefined);
  p.clock = { enable: true, tapButton: 7, bpmFader: 3, defaultBpm: 140 };
  p.chord_velocity = 77;
  p.shiftTarget = 3;
  const bytes = encodeProfile(p, 10);
  assert.deepEqual([...bytes.slice(1034, 1038)], [77, 3, 187, 140]);
  assert.deepEqual(decodeProfile(bytes).clock, p.clock);
  p.clock = { enable: false, tapButton: 15, bpmFader: 7, defaultBpm: 120 };
  assert.deepEqual(decodeProfile(encodeProfile(p, 9)).clock, p.clock);
});

test('unsupported explicit encode versions are rejected', () => {
  for (const version of [8, 11, 9.5, '10']) {
    assert.throws(() => encodeProfile(profile(), version));
  }
});

test('hello pver selects v9 or v10', () => {
  assert.equal(pickEncodeVersion({ pver: 9 }), 9);
  assert.equal(pickEncodeVersion({ pver: 10 }), 10);
});
