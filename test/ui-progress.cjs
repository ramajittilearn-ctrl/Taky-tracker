// Playwright test for the public timeline /progress/. Env: BASE, PIN, PW_DIR, MODE=empty|full
const { chromium } = require((process.env.PW_DIR || '/workspace/pw-test') + '/node_modules/playwright');
const BASE = process.env.BASE, MODE = process.env.MODE || 'full';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS progress-ui:', name); } else { fail++; console.log('FAIL progress-ui:', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const PRIVATE = /ชำระ|จ่าย|บาท|\bpaid\b|\bnote\b|\bdone\b|"amount"|\d{3},\d{3}|X-Edit-Pin|trackerPin/i;

async function run(browser, vp, label) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: vp.width < 600, isMobile: vp.width < 600 });
  const page = await ctx.newPage();
  const errors = [], bodies = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text() + (m.location().url || ''))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => { const ct = r.headers()['content-type'] || ''; if (/json|html|javascript|text/.test(ct)) { try { bodies.push({ url: r.url(), text: await r.text() }); } catch (_) {} } });
  const resp = await page.goto(BASE + '/progress/'); await page.waitForLoadState('networkidle');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`${label}: no horizontal overflow`, overflow <= 0, overflow);
  ok(`${label}: X-Robots-Tag noindex header + meta`, /noindex/.test(resp.headers()['x-robots-tag'] || '') && (await page.locator('meta[name=robots][content=noindex]').count()) === 1);
  if (MODE === 'empty') {
    ok(`${label}: friendly Thai empty state`, await page.isVisible('#empty') && /ยังไม่มีรูป/.test(await page.textContent('#empty')));
    ok(`${label}: no Load more / jump when empty`, !(await page.isVisible('#more')) && !(await page.isVisible('#jump')));
  } else {
    ok(`${label}: empty state hidden`, !(await page.isVisible('#empty')));
    const heads = await page.$$eval('.day h2 small', (n) => n.map((x) => x.textContent.split(' ')[0]));
    ok(`${label}: groups by date, newest first`, heads.length >= 3 && heads[0] === '2026-10-11' && heads.every((d, i) => i === 0 || heads[i - 1] > d), heads);
    ok(`${label}: 24 photos on first page + Load more visible`, (await page.locator('.item').count()) === 24 && await page.isVisible('#more'), await page.locator('.item').count());
    const first = await page.locator('#d-2026-10-11 .item').count();
    ok(`${label}: 6 real site photos grouped under 2026-10-11`, first === 6, first);
    ok(`${label}: Thai/English caption shown`, /เตรียมพื้นที่และปรับระดับดินด้วยรถแบ็คโฮ \/ Soil clearing and levelling with excavator/.test(await page.textContent('#d-2026-10-11 .item >> nth=0')));
    ok(`${label}: images lazy + alt from caption`, (await page.getAttribute('.item img', 'loading')) === 'lazy' && /Soil clearing/.test(await page.getAttribute('#d-2026-10-11 .item img', 'alt')));
    const jumpVisible = vp.width < 570 ? '#jumpSel' : '.chips';
    ok(`${label}: date jump control visible (${jumpVisible})`, await page.isVisible(jumpVisible));
    const target = (heads[heads.length - 1]);
    await page.click('#more'); await page.waitForFunction(() => document.querySelectorAll('.item').length > 24);
    ok(`${label}: Load more appends the rest and hides itself`, (await page.locator('.item').count()) === 27 && !(await page.isVisible('#more')), await page.locator('.item').count());
    const heads2 = await page.$$eval('.day h2 small', (n) => n.map((x) => x.textContent.split(' ')[0]));
    ok(`${label}: still newest first after Load more`, heads2.every((d, i) => i === 0 || heads2[i - 1] > d), heads2);
    const last = heads2[heads2.length - 8]; // a day with enough content below to reach the top
    if (vp.width < 570) await page.selectOption('#jumpSel', last); else await page.click(`.chip >> nth=${heads2.length - 8}`);
    await page.waitForTimeout(1200);
    const top = await page.$eval('#d-' + last, (e) => e.getBoundingClientRect().top);
    ok(`${label}: date jump scrolls to that day`, top < 140 && top > -50 && (await page.evaluate(() => scrollY)) > 200, top);
    await page.evaluate(() => scrollTo(0, 0));
    await page.click('#d-2026-10-11 .item button >> nth=0');
    ok(`${label}: tap-to-enlarge lightbox`, await page.isVisible('#lb.open') && /2026|2569/.test(await page.textContent('#lbCap')));
    ok(`${label}: lightbox close >=44px`, (await page.locator('#lbClose').boundingBox()).height >= 44);
    await page.click('#lbClose');
    ok(`${label}: no horizontal overflow (full)`, (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    ok(`${label}: no edit controls / PIN / links to tracker`, (await page.locator('input[type=file],#pinModal,a[href]').count()) === 0);
  }
  const leaks = bodies.filter((b) => PRIVATE.test(b.text)).map((b) => b.url);
  ok(`${label}: nothing private in page text or JSON/HTML responses (${bodies.length} checked)`, leaks.length === 0 && !PRIVATE.test(await page.evaluate(() => document.body.innerText)), leaks);
  ok(`${label}: no request to /api/milestones`, !bodies.some((b) => /\/api\/milestones/.test(b.url)));
  ok(`${label}: no console errors`, errors.length === 0, errors);
  await ctx.close();
}
(async () => {
  const browser = await chromium.launch();
  await run(browser, { width: 390, height: 844 }, '390x844');
  await run(browser, { width: 1280, height: 800 }, '1280x800');
  await browser.close();
  console.log(`PROGRESS UI RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL progress-ui: exception', e.message); process.exit(1); });
