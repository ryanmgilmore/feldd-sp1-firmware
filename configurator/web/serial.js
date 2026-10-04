// Readable port of feldd.com's WebSerial transport and demo device.
import { decodeProfile, encodeProfile, fromBase64 } from './codec.js';
import { TEMPLATES } from './templates.js';

export const SERIAL_DEBUG = true;
let logSink = null;
export function setSerialLogSink(sink) { logSink = sink; }
function log(...parts) {
  const line = parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
  console.log('[feldd-serial]', line);
  try { logSink?.(line); } catch { /* A UI log hook must not interrupt transport. */ }
}

export function detectCapabilities() {
  const navigator = globalThis.navigator;
  const serial = !!navigator && 'serial' in navigator;
  const midi = !!navigator && typeof navigator.requestMIDIAccess === 'function';
  return { serial, midi, ok: serial && midi };
}

export class LineSplitter {
  decoder = new TextDecoder('utf-8');
  buf = '';
  overflow = false;
  constructor(maxLineLen = 2048) { this.maxLineLen = maxLineLen; }
  push(bytes) {
    this.buf += this.decoder.decode(bytes, { stream: true });
    const lines = [];
    let newline;
    while ((newline = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, newline);
      this.buf = this.buf.slice(newline + 1);
      if (this.overflow) this.overflow = false;
      else {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length) lines.push(line);
      }
    }
    // The source limits only incomplete lines, not a complete line in one chunk.
    if (this.buf.length > this.maxLineLen) {
      this.buf = '';
      this.overflow = true;
    }
    return lines;
  }
}

export class Sp1Serial {
  port = null;
  writer = null;
  reader = null;
  splitter = new LineSplitter();
  encoder = new TextEncoder();
  nextId = 1;
  pending = new Map();
  rawLineListeners = new Set();
  listeners = { mon: new Set(), active: new Set(), mode: new Set(), playrole: new Set(), disconnect: new Set() };
  _connected = false;
  _disconnected = false;
  readLoopDone = null;

  get connected() { return this._connected; }
  on(event, listener) { this.listeners[event].add(listener); }
  emit(event, message) { for (const listener of this.listeners[event]) listener(message); }

  async connect() {
    const serial = globalThis.navigator?.serial;
    if (!serial) throw Error('WebSerial unavailable (Chromium-only); feature-detect before connect()');
    const port = await serial.requestPort({ filters: [{ usbVendorId: 6421 }] });
    await port.open({ baudRate: 115200 });
    try { await port.setSignals?.({ dataTerminalReady: true, requestToSend: true }); } catch {}
    this.port = port;
    if (!port.writable || !port.readable) throw Error('serial port missing readable/writable streams');
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.splitter = new LineSplitter();
    this._connected = true;
    this._disconnected = false;
    this.readLoopDone = this.readLoop();
  }

  async readLoop() {
    const reader = this.reader;
    if (!reader) return;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        log('rx-bytes', value.length, JSON.stringify(new TextDecoder().decode(value)));
        for (const line of this.splitter.push(value)) {
          log('<<', JSON.stringify(line));
          for (const listener of this.rawLineListeners) {
            try { listener(line); } catch {}
          }
          this.handleLine(line);
        }
      }
    } catch { /* Read errors are disconnects, as in the source transport. */ }
    finally { this.handleDisconnect(); }
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.t === 'mon') {
      const event = ['active', 'mode', 'playrole'].includes(message.k) ? message.k : 'mon';
      this.emit(event, message);
      return;
    }
    // Replies are matched by numeric id, without checking the reply verb.
    const pending = typeof message.i === 'number' ? this.pending.get(message.i) : undefined;
    if (!pending) return;
    this.pending.delete(message.i);
    if ((message.t === 'err' || message.ok === false) && !pending.raw) {
      const error = Error(`${message.code ?? 'ERR'}: ${message.msg ?? ''}`);
      error.code = message.code;
      pending.reject(error);
    } else pending.resolve(message);
  }

  handleDisconnect() {
    if (this._disconnected) return;
    this._disconnected = true;
    this._connected = false;
    for (const pending of this.pending.values()) pending.reject(Error('disconnected'));
    this.pending.clear();
    this.emit('disconnect', { t: 'disconnect' });
  }

  async request(verb, args = {}) {
    return this.sendRequest(verb, args, { timeoutMs: 2000 });
  }

  async sendRequest(verb, args, { timeoutMs, raw = false }) {
    if (!this.writer) throw Error('not connected');
    const id = this.nextId++;
    const line = JSON.stringify({ t: verb, i: id, ...args }) + '\n';
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(Error(`timeout after ${timeoutMs}ms waiting for ${verb}_r`));
      }, timeoutMs);
      this.pending.set(id, {
        raw,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
    log('>>', JSON.stringify(line));
    // Install rejection handling before writing; a disconnect may race the write.
    const write = Promise.resolve().then(() => this.writer.write(this.encoder.encode(line))).catch(error => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error);
      throw error;
    });
    const [, message] = await Promise.all([write, reply]);
    return message;
  }

  async getMode() { const reply = await this.request('mode'); return typeof reply.v === 'number' ? reply.v : 0; }
  async setMode(value) { const reply = await this.request('mode', { v: value }); return typeof reply.v === 'number' ? reply.v : value; }
  async getPlayRole() { const reply = await this.request('playrole'); return typeof reply.v === 'number' ? reply.v : 0; }
  async setPlayRole(value) { const reply = await this.request('playrole', { v: value }); return typeof reply.v === 'number' ? reply.v : value; }
  async getMidiThru() { const reply = await this.request('midithru'); return typeof reply.v === 'number' ? reply.v : 0; }
  async setMidiThru(value) { const reply = await this.request('midithru', { v: value }); return typeof reply.v === 'number' ? reply.v : value; }
  async bleThru(args, fallback) {
    try {
      const reply = await this.request('blethru', args);
      if (reply.t === 'err' && reply.code === 'BAD_VERB') return null;
      return typeof reply.v === 'number' ? reply.v : fallback;
    } catch (error) {
      if (error.code === 'BAD_VERB') return null;
      throw error;
    }
  }
  async getBleThru() { return this.bleThru({}, 0); }
  async setBleThru(value) { return this.bleThru({ v: value }, value); }

  async close() {
    this._connected = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this.readLoopDone; } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { await this.writer?.close(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.reader = this.writer = this.port = null;
    this.handleDisconnect();
  }
}

function demoProfile(profile) {
  // Normalize template-era versions and give every demo slot its v10 tail.
  return { ...decodeProfile(encodeProfile(profile, 10)), labels: structuredClone(profile.labels) };
}

export class MockSp1Serial {
  active = [0, 0];
  mode = 0;
  play_mode = 0;
  midi_thru = 0;
  ble_thru = 0;
  monOn = false;
  listeners = { mon: [], active: [], mode: [], playrole: [], disconnect: [] };
  timer = null;
  phase = 0;
  connected = false;
  constructor() {
    this.profiles = Array.from({ length: 16 }, (_, index) => demoProfile(TEMPLATES[index % TEMPLATES.length].profile));
  }
  absActive() { return 8 * this.mode + this.active[this.mode]; }
  async connect() { this.connected = true; this.timer = setInterval(() => this.tick(), 120); }
  async close() { this.connected = false; clearInterval(this.timer); this.timer = null; this.fire('disconnect', {}); }
  on(event, listener) { (this.listeners[event] ||= []).push(listener); }
  fire(event, message) { (this.listeners[event] || []).forEach(listener => listener(message)); }
  // A real SP-1 answers over USB a few ms later; replying synchronously hid a
  // re-render race in the configurator (rename wiped out by setactive's reply).
  latencyMs = 15;
  async request(verb, args = {}) {
    if (this.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    switch (verb) {
      case 'hello': return {
        t: 'hello_r', ok: true, proto: 1, pver: 10, fw: '0.1.0-demo', profiles: 16,
        active: this.absActive(), faders: 4, buttons: 9,
        caps: ['trs', 'usbmidi', 'shift', 'led', 'mon', 'layer8', 'trsout'], pbytes: 1065, uid: 'demo0000',
      };
      case 'list': return {
        t: 'list_r', active: this.absActive(),
        profiles: Array.from({ length: 8 }, (_, slot) => {
          const n = 8 * this.mode + slot;
          return { n, name: this.profiles[n].name, ver: this.profiles[n].version };
        }),
      };
      case 'read': return { t: 'read_r', n: args.n, profile: structuredClone(this.profiles[args.n]) };
      case 'write': {
        const profile = args.profile ?? (typeof args.data === 'string' ? decodeProfile(fromBase64(args.data)) : undefined);
        if (profile) this.profiles[args.n] = demoProfile(profile);
        return { t: 'write_r', n: args.n, ok: !!profile };
      }
      case 'setactive':
        if (typeof args.n !== 'number' || args.n < 0 || args.n >= 8) return { t: 'err', ok: false, code: 'BAD_INDEX', msg: 'bad index' };
        this.active[this.mode] = args.n;
        this.fire('active', { t: 'mon', k: 'active', n: this.absActive() });
        return { t: 'setactive_r', active: args.n };
      case 'getactive': return { t: 'getactive_r', active: this.absActive() };
      case 'monset': this.monOn = !!args.on; return { t: 'monset_r', on: this.monOn };
      case 'mode':
        if (typeof args.v === 'number') await this.setMode(args.v);
        return { t: 'mode_r', ok: true, v: this.mode };
      case 'playrole':
        if (typeof args.v === 'number') await this.setPlayRole(args.v);
        return { t: 'playrole_r', ok: true, v: this.play_mode };
      case 'midithru':
        if (typeof args.v === 'number') await this.setMidiThru(args.v);
        return { t: 'midithru_r', ok: true, v: this.midi_thru };
      case 'blethru':
        if (typeof args.v === 'number') await this.setBleThru(args.v);
        return { t: 'blethru_r', ok: true, v: this.ble_thru };
      case 'trsmode': {
        // v10 firmware: the live jack follows the active profile (bench `v` sets
        // are live-only, not modelled here). hw 1 = TIMER+PPI path.
        const mode = this.profiles[this.absActive()].jack?.mode ?? 0;
        return { t: 'trsmode_r', ok: true, v: mode, hw: 1, live: mode, fires: this.fires ?? 0, busy: 0, pin: 0, fault: 0 };
      }
      case 'trspulse': {
        const live = this.profiles[this.absActive()].jack?.mode ?? 0;
        if (live) this.fires = (this.fires ?? 0) + 1;
        return { t: 'trspulse_r', ok: true, fires: this.fires ?? 0, busy: 0 };
      }
      case 'reset': this.profiles[args.n] = demoProfile(TEMPLATES[0].profile); return { t: 'reset_r', n: args.n };
      case 'resetall':
        this.profiles = this.profiles.map(() => demoProfile(TEMPLATES[0].profile));
        this.active = [0, 0];
        return { t: 'resetall_r' };
      default: return { t: 'err', code: 'BAD_VERB' };
    }
  }
  async getMode() { return this.mode; }
  async setMode(value) {
    this.mode = +!!value;
    this.fire('mode', { t: 'mon', k: 'mode', v: this.mode });
    this.fire('active', { t: 'mon', k: 'active', n: this.absActive() });
    return this.mode;
  }
  async getPlayRole() { return this.play_mode; }
  async setPlayRole(value) {
    this.play_mode = +!!value;
    this.fire('playrole', { t: 'mon', k: 'playrole', v: this.play_mode });
    return this.play_mode;
  }
  async getMidiThru() { return this.midi_thru; }
  async setMidiThru(value) { this.midi_thru = +!!value; return this.midi_thru; }
  async getBleThru() { return this.ble_thru; }
  async setBleThru(value) { this.ble_thru = +!!value; return this.ble_thru; }
  get activeProfile() { return this.profiles[this.absActive()]; }
  tick() {
    if (!this.monOn) return;
    this.phase += 0.08;
    for (let index = 0; index < 4; index++) {
      this.fire('mon', { t: 'mon', k: 'f', ix: index, v: Math.round(63 + 63 * Math.sin(this.phase + 1.6 * index)) });
    }
  }
}
