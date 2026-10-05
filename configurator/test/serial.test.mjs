import test from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, Sp1Serial, MockSp1Serial, setSerialLogSink, parseReplyLine } from '../web/serial.js';
import { encodeProfile, toBase64 } from '../web/codec.js';
const utf8 = new TextEncoder();

function transport(respond) {
  const serial = new Sp1Serial();
  serial.writer = { write(bytes) { respond(JSON.parse(new TextDecoder().decode(bytes)), serial); } };
  return serial;
}

test('line framing handles split UTF-8, CRLF, blank lines, and overflow recovery', () => {
  const splitter = new LineSplitter(4);
  const bytes = utf8.encode('é\r\n\n');
  assert.deepEqual(splitter.push(bytes.slice(0, 1)), []);
  assert.deepEqual(splitter.push(bytes.slice(1)), ['é']);
  assert.deepEqual(splitter.push(utf8.encode('12345')), []);
  assert.deepEqual(splitter.push(utf8.encode('discard\nok\n')), ['ok']);
  assert.deepEqual(splitter.push(utf8.encode('complete long line\n')), ['complete long line']);
});

test('serial requests use ids, one JSON line, and numeric-id matching without verb checking', async () => {
  const sent = [];
  const serial = transport((frame, port) => {
    sent.push(frame);
    port.handleLine(JSON.stringify({ t: 'unrelated_r', i: String(frame.i), v: 9 }));
    port.handleLine(JSON.stringify({ t: 'unrelated_r', i: frame.i, v: 1 }));
  });
  assert.equal(await serial.getMidiThru(), 1);
  assert.equal(await serial.setMidiThru(0), 1);
  assert.deepEqual(sent, [{ t: 'midithru', i: 1 }, { t: 'midithru', i: 2, v: 0 }]);
  assert.equal(serial.pending.size, 0);
});

test('blethru uses midithru shape; only BAD_VERB returns null', async () => {
  const serial = transport((frame, port) => port.handleLine(JSON.stringify({ t: 'blethru_r', i: frame.i, v: frame.v ?? 0 })));
  assert.equal(await serial.getBleThru(), 0);
  assert.equal(await serial.setBleThru(1), 1);
  const unsupported = transport((frame, port) => port.handleLine(JSON.stringify({ t: 'err', i: frame.i, code: 'BAD_VERB' })));
  assert.equal(await unsupported.getBleThru(), null);
  assert.equal(await unsupported.setBleThru(1), null);
  const failed = transport((frame, port) => port.handleLine(JSON.stringify({ t: 'err', i: frame.i, code: 'BUSY', msg: 'later' })));
  await assert.rejects(failed.getBleThru(), /BUSY: later/);
});

test('normal requests default to 2000 ms and timeout pending entries', async () => {
  const serial = new Sp1Serial();
  serial.sendRequest = async (verb, args, options) => options.timeoutMs;
  assert.equal(await serial.request('hello'), 2000);
  const quiet = transport(() => {});
  await assert.rejects(quiet.sendRequest('hello', {}, { timeoutMs: 5 }), /timeout after 5ms waiting for hello_r/);
  assert.equal(quiet.pending.size, 0);
});

test('write failures and disconnect reject and clean pending requests', async () => {
  const broken = transport(() => { throw Error('write failed'); });
  await assert.rejects(broken.request('hello'), /write failed/);
  assert.equal(broken.pending.size, 0);
  const serial = transport(() => {});
  let disconnects = 0;
  serial.on('disconnect', () => disconnects++);
  const reply = serial.request('hello');
  serial.handleDisconnect();
  serial.handleDisconnect();
  await assert.rejects(reply, /disconnected/);
  assert.equal(serial.pending.size, 0);
  assert.equal(disconnects, 1);
});

test('read loop delivers raw text, log hooks, routed monitors, and disconnect', async () => {
  const serial = new Sp1Serial();
  const raw = [], logs = [], events = [];
  for (const kind of ['active', 'mode', 'playrole', 'mon', 'disconnect']) serial.on(kind, message => events.push([kind, message]));
  serial.rawLineListeners.add(line => raw.push(line));
  serial.rawLineListeners.add(() => { throw Error('ignored hook'); });
  const chunks = ['status\r\nnull\n', ...['active', 'mode', 'playrole', 'f'].map(k => JSON.stringify({ t: 'mon', k }) + '\n')];
  serial.reader = { async read() { return chunks.length ? { value: utf8.encode(chunks.shift()), done: false } : { done: true }; } };
  setSerialLogSink(line => logs.push(line));
  try { await serial.readLoop(); } finally { setSerialLogSink(null); }
  assert.equal(raw[0], 'status');
  assert.deepEqual(events.map(([kind]) => kind), ['active', 'mode', 'playrole', 'mon', 'disconnect']);
  assert.ok(logs.some(line => line.startsWith('rx-bytes')));
  assert.ok(logs.some(line => line.startsWith('<<')));
});

test('mock advertises v10, preserves jack writes, supports blethru, and emits absolute active slots', async () => {
  const serial = new MockSp1Serial();
  const hello = await serial.request('hello');
  assert.equal(hello.pver, 10);
  assert.equal(hello.pbytes, 1065);
  assert.ok(hello.caps.includes('trsout'));
  assert.equal(serial.activeProfile.version, 10);
  assert.equal(serial.activeProfile.jack.width, 100);
  assert.equal(await serial.getBleThru(), 0);
  assert.equal(await serial.setBleThru(1), 1);
  assert.equal((await serial.request('blethru')).v, 1);
  const events = [];
  serial.on('active', frame => events.push(frame.n));
  await serial.setMode(1);
  await serial.request('setactive', { n: 3 });
  assert.deepEqual(events, [8, 11]);
  const profile = structuredClone(serial.activeProfile);
  profile.jack.mode = 2;
  profile.jack.sync_div[3] = 24;
  await serial.request('write', { n: 11, data: toBase64(encodeProfile(profile, 10)) });
  assert.deepEqual((await serial.request('read', { n: 11 })).profile.jack, profile.jack);
  await serial.request('reset', { n: 11 });
  assert.equal(serial.activeProfile.jack.mode, 0);
  const monitors = [];
  serial.on('mon', frame => monitors.push(frame));
  await serial.request('monset', { on: true });
  serial.tick();
  assert.equal(monitors.length, 4);
});

test('WebSerial opens the Nordic vendor at 115200 and closes stream locks', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  let finishRead;
  const port = {
    async open(options) { calls.push(['open', options]); },
    async setSignals(signals) { calls.push(['signals', signals]); },
    readable: { getReader() { return {
      read() { return new Promise(resolve => { finishRead = resolve; }); },
      async cancel() { finishRead({ done: true }); },
      releaseLock() { calls.push(['reader released']); },
    }; } },
    writable: { getWriter() { return {
      async close() { calls.push(['writer closed']); },
      releaseLock() { calls.push(['writer released']); },
    }; } },
    async close() { calls.push(['port closed']); },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: {
    async requestPort(options) { calls.push(['request', options]); return port; },
  } } });
  const serial = new Sp1Serial();
  try {
    await serial.connect();
    assert.equal(serial.connected, true);
    await serial.close();
    assert.equal(serial.connected, false);
    await assert.rejects(serial.request('hello'), /not connected/);
    assert.deepEqual(calls, [
      ['request', { filters: [{ usbVendorId: 6421 }] }],
      ['open', { baudRate: 115200 }],
      ['signals', { dataTerminalReady: true, requestToSend: true }],
      ['reader released'], ['writer closed'], ['writer released'], ['port closed'],
    ]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
});

test('a reply spliced onto the end of a firmware status line is still parsed', () => {
  // As captured from the combined feldd + DXP1 firmware, 2026-10-05.
  const spliced = 'diag t=7865 blk=0 FLASH erase feldd at=0x{"t":"hello_r","i":1,"ok":true,"proto":1,"pver":10,"fw":"0.31.0r","profiles":16}';
  assert.deepEqual(parseReplyLine(spliced), { t: 'hello_r', i: 1, ok: true, proto: 1, pver: 10, fw: '0.31.0r', profiles: 16 });
  assert.deepEqual(parseReplyLine('{"t":"read_r","i":3,"ok":true}'), { t: 'read_r', i: 3, ok: true });
  assert.equal(parseReplyLine('dexed-fw feldd-DXP1 0.31.0r+1.0-dev i2s_rc=0 blocks=704'), null);
  assert.equal(parseReplyLine('status {"t": broken'), null);
  assert.equal(parseReplyLine('42'), null);
  // A reply cut into by other output cannot be rescued, and is not misread.
  assert.equal(parseReplyLine('x{"t":"hello_r","i":1,"pver":1dexed-fw i2s_rc=0 0}'), null);
});

test('handleLine resolves a pending request from a spliced reply', async () => {
  const serial = transport((frame, port) => {
    port.handleLine('dexed-fw feldd-DXP1 0.31.0r+1.0-dev i2s_rc=0 blocks=21031 us_mean=292');
    port.handleLine('diag t=7865 blk=0 FLASH erase feldd at=0x' + JSON.stringify({ t: 'hello_r', i: frame.i, ok: true, pver: 10, fw: '0.31.0r' }));
  });
  const hello = await serial.request('hello');
  assert.equal(hello.fw, '0.31.0r');
  assert.equal(hello.pver, 10);
  assert.equal(serial.pending.size, 0);
});
