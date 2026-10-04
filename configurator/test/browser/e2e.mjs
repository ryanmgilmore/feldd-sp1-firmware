import puppeteer from 'puppeteer-core';
const SP = process.argv[2] || '.';
const errors = [];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--window-size=1440,1400'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1400 });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(`${process.env.BASE || 'http://localhost:8765'}/index.html?demo=1`);
await page.waitForFunction(() => document.getElementById('conn-status').textContent.includes('demo'), { timeout: 5000 });
const txt = (sel) => page.$eval(sel, (e) => e.textContent.trim());
const clickText = async (scope, text) => {
  const ok = await page.evaluate((scope, text) => {
    const b = [...document.querySelectorAll(scope + ' button')].find((x) => x.textContent.trim() === text);
    if (!b) return false; b.click(); return true;
  }, scope, text);
  if (!ok) throw new Error(`no button "${text}" in ${scope}`);
  await new Promise((r) => setTimeout(r, 150));
};
const out = [];
const check = (name, cond) => out.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);

check('initial save button reads Saved', (await txt('#btn-save')) === 'Saved');
await clickText('#jack-body', 'trigger');
check('trigger makes the profile dirty', (await txt('#btn-save')).startsWith('Save changes'));
check('trigger shows note + channel', await page.$eval('#jack-body', (e) => /note/.test(e.textContent) && /channel/.test(e.textContent)));
await page.evaluate(() => { const c = document.querySelector('#jack-body input[type=checkbox]'); c.click(); });
await new Promise((r) => setTimeout(r, 150));
check('per-layer grid appears', !!(await page.$('#jack-body .jack-grid')));
// set L2 note (second number input in the grid's note row) to 38
await page.evaluate(() => { const ins = document.querySelectorAll('#jack-body .jack-grid input[type=number]'); ins[1].value = '38'; ins[1].dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 150));
await page.screenshot({ path: SP + '/e2e-jack.png' });
await page.click('#btn-save');
await page.waitForFunction(() => document.getElementById('btn-save').textContent === 'Saved', { timeout: 3000 });
check('save completes', true);
check('device now reports trigger', await page.$eval('#jack-body', (e) => e.textContent.includes('on the device now: trigger')));
await clickText('#jack-body', 'test pulse');
await new Promise((r) => setTimeout(r, 200));
check('test pulse counts', await page.$eval('#jack-body', (e) => e.textContent.includes('pulses fired 1')));
await clickText('#thru-ble', 'on');
check('BLE thru on', await page.$eval('#thru-ble button[data-v="1"]', (e) => e.getAttribute('aria-selected') === 'true'));
// switch to slot 2: jack follows the profile
await page.evaluate(() => document.querySelectorAll('#slots li')[1].click());
await new Promise((r) => setTimeout(r, 300));
check('slot 2 jack is MIDI on device', await page.$eval('#jack-body', (e) => e.textContent.includes('on the device now: MIDI out')));
await page.evaluate(() => document.querySelectorAll('#slots li')[0].click());
await new Promise((r) => setTimeout(r, 300));
check('back to slot 1: trigger again', await page.$eval('#jack-body', (e) => e.textContent.includes('on the device now: trigger')));
check('grid still per-layer after reload (L2 differs)', !!(await page.$('#jack-body .jack-grid')));
// sync mode shows division
await clickText('#jack-body', 'sync');
check('sync shows division', await page.$eval('#jack-body', (e) => e.textContent.includes('division')));
// chord editor
await page.evaluate(() => { const s = document.querySelector('.card[data-ctl="b1"] select'); s.value = 'chord'; s.dispatchEvent(new Event('change')); });
await new Promise((r) => setTimeout(r, 150));
check('chord editor shows keys', !!(await page.$('.card[data-ctl="b1"] .keys')));
await page.evaluate(() => { const k = document.querySelectorAll('.card[data-ctl="b1"] .keys button'); k[0].click(); k[4].click(); k[7].click(); });
await new Promise((r) => setTimeout(r, 150));
check('chord summary C E G', (await txt('.card[data-ctl="b1"] .summary')).includes('C3 E3 G3'));
// layers, basic view, keyboard mode
await clickText('#layer-tabs', 'L3');
check('L3 cards titled', await page.$eval('#editor', (e) => e.textContent.includes('(L3)')));
await clickText('#view-tabs', 'basic');
check('basic view nav', !!(await page.$('.basic-nav')));
await clickText('#view-tabs', 'advanced');
await clickText('#mode-tabs', 'Keyboard');
check('keyboard cards', await page.$eval('#editor', (e) => e.textContent.includes('Buttons (keys)')));
await page.screenshot({ path: SP + '/e2e-kbd.png' });
// live monitor ticks
const mon = await page.$eval('#mon-grid', (e) => e.textContent);
check('monitor has values', /F1\d/.test(mon.replace(/\s/g, '')));
// light theme + narrow
await page.click('#btn-theme');
await page.setViewport({ width: 390, height: 1600 });
await new Promise((r) => setTimeout(r, 200));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check('no horizontal scroll at 390px', !overflow);
await page.screenshot({ path: SP + '/e2e-phone.png' });
console.log(out.join('\n'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
