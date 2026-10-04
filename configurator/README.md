# SP-1 configurator

<!-- DRAFT — Ryan to reword. Copied to the fork as configurator/README.md by sync-to-fork.sh. -->

A WebSerial page for configuring feldd on a Teenage Engineering SP-1: the eight
profile slots in each mode, every mapping, eight layers, keyboard mode, MIDI
clock, starter profiles, and a live monitor — plus the two things this fork
adds:

- **the TRS sync jack's role per profile** — MIDI out, analog trigger, or analog
  sync, with per-layer trigger note, channel and sync division
- **MIDI thru from USB to Bluetooth**, on its own switch beside USB → TRS thru

It reads and writes both profile v9 (upstream feldd) and v10 (this fork).

**Live:** [link — set when GitHub Pages is on]. Chromium browsers only (Chrome,
Edge, Arc); `?demo=1` runs it against a simulated SP-1.

## Credit

The SP-1 drawing, the profile codec, the serial transport and the starter
profiles are ported from feldd.com's configurator by Benjamin Reece
(https://feldd.com/sp-1/configure). The page itself, the v10 TRS sync jack support and
the Bluetooth thru switch are new.

## Running it locally

```sh
cd configurator/web && python3 -m http.server 8765   # http://localhost:8765
```

ES modules need http(s), not `file://`; WebSerial needs a secure context, and
`localhost` counts.

## Tests

```sh
cd configurator && node --test test/
```

The golden profile strings are read from `../firmware/test/test_profile.c` at
test time, so the page, `scripts/sp1ctl.py` and the firmware are held to the
same bytes. `test/browser/` drives the page in Chrome against the demo device
(needs `puppeteer-core`).
