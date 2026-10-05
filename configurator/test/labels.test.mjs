import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_IDS, LABEL_REC_MAX, decodeLabelRecord, encodeLabelRecord } from '../web/codec.js';
import { MockSp1Serial } from '../web/serial.js';

test('label record encoding is canonical and round-trips', () => {
  const record = encodeLabelRecord({ F2: 'Sustain', T1: 'C maj' });
  assert.deepEqual([...record], [1, 1, 7, 83, 117, 115, 116, 97, 105, 110, 5, 5, 67, 32, 109, 97, 106]);
  assert.deepEqual(decodeLabelRecord(record), { F2: 'Sustain', T1: 'C maj' });
});

test('label records obey byte limits and clean text', () => {
  const all = Object.fromEntries(CONTROL_IDS.map(id => [id, 'abcdefghijklmnopqrstuvwx']));
  assert.equal(encodeLabelRecord(all).length, LABEL_REC_MAX);
  assert.deepEqual(decodeLabelRecord(encodeLabelRecord({ F1: `${'a'.repeat(23)}•` })), { F1: 'a'.repeat(23) });
  assert.deepEqual(decodeLabelRecord(encodeLabelRecord({ F1: ' a\n\x7Fb ' })), { F1: 'ab' });
  assert.equal(encodeLabelRecord({ F1: ' \n\x7F ' }), null);
});

test('label record decoder rejects malformed records', () => {
  const rejects = [[], [2, 0, 1, 65], [1, 13, 1, 65], [1, 1, 1, 65, 1, 1, 66], [1, 2, 1, 65, 1, 1, 66], [1, 0, 25, ...Array(25).fill(65)], [1, 0, 1, 10], [1, 0, 1, 65, 0]];
  for (const record of rejects) assert.throws(() => decodeLabelRecord(Uint8Array.from(record)));
});

test('demo stores label records like the device', async () => {
  const serial = new MockSp1Serial();
  const record = encodeLabelRecord({ F2: 'Sustain' });
  await serial.setLabels(3, 2, record);
  assert.equal((await serial.labelMap())[3], 1 << 2);
  assert.deepEqual(await serial.getLabels(3, 2), record);
  await serial.setLabels(3, 2, null);
  assert.equal((await serial.labelMap())[3], 0);
  assert.equal(await serial.getLabels(3, 2), null);
});
