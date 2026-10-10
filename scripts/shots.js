// Screenshots of the page against a LOCAL offline server, for the feature inventory and the before/after sets.
//   BASE_URL=http://127.0.0.1:8123 node scripts/shots.js <out-dir> [full]
// Writes <out-dir>/<tab>-<375|1280>[-dark][-hi].png for the five tabs, and the named states of docs/FEATURE_INVENTORY.md at 375 px.
// With "full" the tab shots are full-page; otherwise they are one viewport. Output directories under screenshots/ stay git-ignored.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL;
if (!BASE) throw new Error('Set BASE_URL to a running Surya Audit server');
const OUT = path.resolve(process.argv[2] || 'screenshots/shots');
const FULL = process.argv[3] === 'full';
const ROOT = path.join(__dirname, '..');
fs.mkdirSync(OUT, { recursive: true });

async function post(url, data) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
async function plant(rows) {
  const site = await post('/api/sites', JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')));
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of lines.slice(0, rows || lines.length)) {
    const [date, kwh, kind] = line.split(',');
    await post(`/api/sites/${site.id}/readings`, { date, kwh: Number(kwh), kind: kind || 'daily' });
  }
  return site.id;
}

(async () => {
  const id = await plant();
  const fresh = await plant(3);
  const browser = await chromium.launch();
  const shoot = async (page, name, full) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full ?? FULL });
  for (const [width, height] of [[375, 812], [1280, 900]]) {
    for (const scheme of ['light', 'dark']) {
      for (const lang of width === 375 ? ['en', 'hi'] : ['en']) {
        const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await page.goto('/');
        await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lang);
        for (const tab of ['today', 'log', 'fix', 'why', 'report']) {
          await page.goto(`/?site=${id}&s=${width}${scheme}${lang}${tab}#${tab}`);
          await page.waitForSelector(`#panel-${tab}:not([hidden])`);
          if (tab === 'why') await page.waitForSelector('#chart svg');
          if (tab === 'report') { await page.locator('#draft-btn').click(); await page.waitForSelector('#draft-out:not([hidden])'); }
          await page.waitForTimeout(300);
          await shoot(page, `${tab}-${width}${scheme === 'dark' ? '-dark' : ''}${lang === 'hi' ? '-hi' : ''}`);
        }
        await ctx.close();
      }
    }
  }
  // named states, phone, light, English, motion allowed except where it would blur the shot
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`/?site=${fresh}&s=fresh#today`);
  await page.waitForSelector('#headline');
  await shoot(page, 'today-learning-375');
  await page.goto(`/?site=${id}&s=bigger#today`);
  await page.evaluate(() => localStorage.setItem('surya-audit-bigger', '1'));
  await page.reload();
  await page.waitForSelector('#headline .ring');
  await shoot(page, 'today-big-375');
  await page.evaluate(() => localStorage.removeItem('surya-audit-bigger'));
  await page.goto(`/?site=${id}&s=assume#today`);
  await page.waitForSelector('#headline .ring');
  if (await page.locator('#impact:not([hidden])').count()) {
    await page.locator('#impact summary').click();
    await shoot(page, 'today-assume-375', true);
  }
  await page.goto(`/?site=${id}&s=why#why`);
  await page.waitForSelector('#chart svg');
  await page.getByText('Show readings as a table').click();
  await shoot(page, 'why-table-375', true);
  await page.goto(`/?site=${id}&s=replay#why`);
  await page.waitForSelector('#chart svg');
  await page.locator('#replay-btn').click();
  await page.waitForTimeout(1200);
  await shoot(page, 'why-replay-375');
  await page.goto(`/?site=${id}&s=imp#log`);
  await page.waitForSelector('#panel-log:not([hidden])');
  await page.locator('#import summary').click();
  await page.locator('#import-text').fill('2026-10-01,12.4\n02/10/2026,11.8\n31/02/2026,5');
  await page.locator('#import-check').click();
  await shoot(page, 'log-import-375', true);
  await page.goto(`/?site=${id}&s=queue#log`);
  await page.waitForSelector('#panel-log:not([hidden])');
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));
  await page.locator('input[name=kwh]').fill('9.9');
  await page.locator('#save-btn').click();
  await page.waitForSelector('#queue:not([hidden])');
  await shoot(page, 'log-queue-375');
  await page.unroute('**/readings');
  await page.evaluate(() => localStorage.clear());  // a remembered plant would hide the bad-link message
  await page.goto('/?site=nope-not-a-plant');
  await page.waitForSelector('#setup:not([hidden])');
  await shoot(page, 'badlink-375');
  await page.goto('/?s=setup');
  await page.waitForSelector('#setup:not([hidden])');
  await shoot(page, 'setup1-375');
  await ctx.close();
  await browser.close();
  console.log(`${fs.readdirSync(OUT).length} screenshots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
