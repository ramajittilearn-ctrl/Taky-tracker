// Playwright UI test. Env: BASE, PIN (throwaway), PW_DIR (dir containing node_modules/playwright), SEED_DIR (optional real photos).
const { chromium } = require((process.env.PW_DIR || '/workspace/pw-test') + '/node_modules/playwright');
const fs = require('fs');
const BASE = process.env.BASE, PIN = process.env.PIN;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ui:', name); } else { fail++; console.log('FAIL ui:', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const BIG = '/tmp/ph/big4000x3000.jpg';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, extraHTTPHeaders: { 'CF-Connecting-IP': '9.9.9.9' } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|status of (401|500)|save_failed_500/.test(m.text() + (m.location().url || ''))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => { window.__uploads = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === 'POST' && String(u).includes('/api/photos')) window.__uploads.push({ url: String(u), size: o.body && o.body.size, type: o.body && o.body.type }); return f(u, o); }; });
  await page.goto(BASE + '/'); await page.waitForSelector('.photos[data-ms="2"] .add');
  ok('390px: no horizontal overflow (before)', (await overflow(page)) <= 0, await overflow(page));
  ok('viewers: tap targets >=44px (Add photos)', (await page.locator('.photos[data-ms="2"] .add').boundingBox()).height >= 44);
  // unlock with wrong PIN first (UI must say wrong PIN), then right PIN
  const choosers = []; page.on('filechooser', (c) => choosers.push(c));
  await page.click('.photos[data-ms="2"] .add');
  await page.fill('#pinInput', '000000'); await page.press('#pinInput', 'Enter');
  await page.waitForFunction(() => /PIN/.test(document.getElementById('pinMsg').textContent));
  ok('wrong PIN message shown before any upload', /Wrong PIN|ไม่ถูกต้อง/.test(await page.textContent('#pinMsg')));
  await page.fill('#pinInput', PIN); await page.press('#pinInput', 'Enter');
  await page.waitForFunction(() => !!sessionStorage.getItem('trackerPin'));
  ok('PIN kept in sessionStorage only (not localStorage)', (await page.evaluate(() => localStorage.length)) === 0);
  await page.waitForTimeout(500);
  if (!choosers.length) await page.click('.photos[data-ms="2"] .add'); // picker may need a second tap after the PIN dialog
  await page.waitForTimeout(300);
  ok('file chooser opened (accept image/*, multiple)', choosers.length >= 1);
  const accept = await page.getAttribute('.photos[data-ms="2"] input[type=file]', 'accept');
  const multi = await page.getAttribute('.photos[data-ms="2"] input[type=file]', 'multiple');
  ok('input accept=image/*, multiple, no capture', accept === 'image/*' && multi !== null && (await page.getAttribute('.photos[data-ms="2"] input[type=file]', 'capture')) === null);
  await choosers[0].setFiles(['/tmp/ph/fake.jpg', BIG]);
  await page.waitForSelector('.stage .srow');
  ok('staging shows 2 rows with date default today', (await page.locator('.stage .srow').count()) === 2 && /^\d{4}-\d{2}-\d{2}$/.test(await page.inputValue('.stage input[type=date]')));
  ok('390px: no overflow with staging open', (await overflow(page)) <= 0, await overflow(page));
  await page.locator('.stage input[type=text]').nth(1).fill('ทดสอบ <img src=x onerror=alert(1)> / UI test');
  await page.locator('.stage input[type=date]').nth(1).fill('2026-10-05');
  const reqP = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/api/photos'));
  await page.click('.stage .sbar .primary');
  const req = await reqP;
  await page.waitForFunction(() => window.__uploads.length >= 1);
  const up = (await page.evaluate(() => window.__uploads)).find((u) => u.size > 1000) || (await page.evaluate(() => window.__uploads))[0];
  const body = { length: up.size };
  ok('uploaded body < 600 KB (was ' + fs.statSync(BIG).size + ' bytes original 4000x3000)', body.length < 600 * 1024, body.length);
  ok('request carries X-Edit-Pin and date/caption', !!req.headers()['x-edit-pin'] && /date=2026-10-05/.test(req.url()) && /milestone=2/.test(req.url()));
  await page.waitForSelector('.photos[data-ms="2"] .pgrid img');
  const dims = await page.evaluate(async () => { const i = document.querySelector('.photos[data-ms="2"] .pgrid img'); await i.decode(); return [i.naturalWidth, i.naturalHeight]; });
  ok('served photo resized: longest side <= 1600 (got ' + dims.join('x') + ')', Math.max(...dims) <= 1600 && Math.max(...dims) >= 1500, dims);
  ok('grid thumbnail: lazy + alt from caption', (await page.getAttribute('.photos[data-ms="2"] .pgrid img', 'loading')) === 'lazy' && /UI test/.test(await page.getAttribute('.photos[data-ms="2"] .pgrid img', 'alt')));
  ok('caption rendered as text (no injected <img>)', (await page.locator('.photos[data-ms="2"] figcaption img').count()) === 0 && /<img src=x/.test(await page.textContent('.photos[data-ms="2"] figcaption')));
  const errTxt = await page.textContent('.stage .srow >> nth=0').catch(() => '');
  ok('fake .jpg row shows a clear TH/EN message and did not block the good photo', /HEIC|อ่านรูปนี้ไม่ได้/.test(errTxt));
  ok('390px: no overflow with photo grid', (await overflow(page)) <= 0, await overflow(page));
  await page.click('.photos[data-ms="2"] .pitem button');
  ok('lightbox opens with date + caption', await page.isVisible('#lightbox.open') && /2026-10-05/.test(await page.textContent('#lbCap')));
  ok('lightbox tap targets >=44px', (await page.locator('#lbClose').boundingBox()).height >= 44);
  await page.click('#lbClose');
  // reset button: failure must not claim success
  await page.route('**/api/milestones', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, body: '{"error":"server_error"}', contentType: 'application/json' }) : r.continue()));
  await page.click('#resetButton'); await page.waitForTimeout(800);
  const st1 = await page.textContent('#saveStatus');
  ok('Reset with failing server: no success claim', !/รีเซ็ตและบันทึกแล้ว/.test(st1) && /ไม่สำเร็จ|failed/i.test(st1), st1);
  await page.unroute('**/api/milestones');
  await page.click('#resetButton'); await page.waitForFunction(() => /รีเซ็ตและบันทึกแล้ว/.test(document.getElementById('saveStatus').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('Reset via force header succeeds (status says saved)', /รีเซ็ตและบันทึกแล้ว/.test(await page.textContent('#saveStatus')), await page.textContent('#saveStatus'));
  const saved = await (await fetch(BASE + '/api/milestones')).json();
  ok('server now holds the 18 default-reset records', Object.keys(saved.records).length === 18 && saved.records['1'].done === true && saved.records['2'].done === false);
  // normal Save after reset (18 ids -> passes the <15 guard)
  await page.click('#saveButton'); await page.waitForFunction(() => /บันทึกแล้ว/.test(document.getElementById('saveStatus').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('normal Save works', /บันทึกแล้ว/.test(await page.textContent('#saveStatus')), await page.textContent('#saveStatus'));
  const seedFiles = fs.existsSync(process.env.SEED_DIR || '/nonexistent') ? fs.readdirSync(process.env.SEED_DIR).filter((f) => /\.jpe?g$/i.test(f)) : [];
  if (seedFiles.length) {
    const orig = process.env.SEED_DIR + '/' + seedFiles[0];
    await page.evaluate(() => { window.__uploads.length = 0; });
    const chP = page.waitForEvent('filechooser');
    await page.click('#generalPhotos .add');
    await (await chP).setFiles([orig]);
    await page.waitForSelector('#generalPhotos .stage .srow');
    await page.fill('#generalPhotos .stage input[type=text]', 'เตรียมพื้นที่และปรับระดับดินด้วยรถแบ็คโฮ / Soil clearing and levelling with excavator');
    await page.click('#generalPhotos .stage .sbar .primary');
    await page.waitForSelector('#generalPhotos .pgrid img');
    const sent = (await page.evaluate(() => window.__uploads))[0];
    ok('real site photo (1477x1108, <2MB) uploaded unchanged, no milestone (general box)', sent && sent.size === fs.statSync(orig).size && !/milestone=/.test(sent.url), sent);
    ok('390px: no overflow with general photos', (await overflow(page)) <= 0, await overflow(page));
  }
  ok('no console errors on the tracker page', errors.length === 0, errors);
  // cleanup photos created by this test
  const list = (await (await fetch(BASE + '/api/photos')).json()).photos;
  for (const p of list) await fetch(BASE + '/api/photos/' + p.id, { method: 'DELETE', headers: { 'X-Edit-Pin': PIN, 'CF-Connecting-IP': '9.9.9.9' } });
  await browser.close();
  console.log(`UI RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL ui: exception', e.message); process.exit(1); });
