// Surface tests for the offline queue: the ONE exception to "the page never sends a write twice" (docs/JUDGE_QA.md).
// Conditions proven here: sent only on the online event, on page load, or when the owner taps Try now (no timers); one reading at a time;
// a reading leaves the queue only after the server confirmed it; a reading for a day the server already holds is never sent by itself
// and shows "N readings waiting, review"; Try now asks the overwrite question first. Forget names the unsaved readings before it deletes them.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY = 'surya-audit-queued-readings';

async function plant(request, rows = 3) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of lines.slice(0, rows)) {
    const [date, kwh, kind] = line.split(',');
    expect((await request.post(`/api/sites/${id}/readings`, { data: { date, kwh: Number(kwh), kind: kind || 'daily' } })).ok()).toBeTruthy();
  }
  return id;
}
// Puts readings in the browser's queue, then opens the plant. The server holds 2026-08-05 to 2026-08-07 (the first three rows).
async function open(page, id, items, hash = '#log') {
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, items.map(([date, kwh]) => ({ site: id, body: { date, kwh, kind: 'daily' } }))]);
  await page.goto(`/?site=${id}${hash}`);
}
const stored = (page) => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) || '[]')).map((q) => q.body.date), KEY);
const posts = (page) => {
  const seen = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/readings')) seen.push(r.postDataJSON().date); });
  return seen;
};

test('no timers: the queue is sent only on page load, the online event and Try now', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf-8');
  // the definition, the Try now button, the online listener and the plant load: nothing else calls it
  expect([...src.matchAll(/flushQueue\(/g)]).toHaveLength(4);
  expect(src.match(/window\.addEventListener\('online'[^\n]*flushQueue/g)).toHaveLength(1);
  expect(src.match(/onclick: \(\) => flushQueue\(true\)/g)).toHaveLength(1);
  expect(src.match(/navigator\.onLine\) flushQueue\(\)/g)).toHaveLength(1);
  const body = src.slice(src.indexOf('function flushQueue'), src.indexOf("window.addEventListener('online'"));
  expect(body).not.toMatch(/setInterval|setTimeout|requestIdleCallback/);
  expect(src.match(/flushQueue(?!\()/g), 'flushQueue is never passed around (a timer could hold it)').toBeNull();
});

test('a reading for a day the server already holds is not sent by itself: it stays queued for review, on load and on the online event', async ({ page, request }) => {
  const id = await plant(request);
  const sent = posts(page);
  await open(page, id, [['2026-08-05', 5.9]]);  // the server has 5.4 for that day
  await expect(page.locator('#queue')).toContainText('1 reading waiting, review');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1200);
  expect(sent).toEqual([]);
  expect(await stored(page)).toEqual(['2026-08-05']);
  await expect(page.locator('#queue')).toContainText('1 reading waiting, review');
});

test('Try now asks the overwrite question for a day the server holds: Cancel sends nothing, OK sends it once and removes it only after the server confirmed', async ({ page, request }) => {
  const id = await plant(request);
  const sent = posts(page);
  await open(page, id, [['2026-08-05', 5.9]]);
  await expect(page.locator('#queue')).toContainText('review');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect.poll(() => asked).toContain('is already saved');
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect(await stored(page)).toEqual(['2026-08-05']);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.locator('#queue')).toBeHidden();
  expect(sent).toEqual(['2026-08-05']);
  expect(await stored(page)).toEqual([]);
});

test('one at a time, and a reading is removed only after the server confirmed it', async ({ page, request }) => {
  const id = await plant(request);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  let first = true;
  await page.route('**/readings', async (route) => {
    seen.push(route.request().postDataJSON().date);
    if (first) { first = false; await gate; }  // the first answer is held back
    await route.continue();
  });
  await open(page, id, [['2026-08-20', 9.9], ['2026-08-21', 8.8]]);
  await expect.poll(() => seen.length).toBe(1);
  await page.waitForTimeout(600);
  expect(seen, 'the second is not sent while the first is unanswered').toEqual(['2026-08-20']);
  expect(await stored(page), 'nothing is removed before the answer').toEqual(['2026-08-20', '2026-08-21']);
  release();
  await expect(page.locator('#queue')).toBeHidden();
  expect(seen).toEqual(['2026-08-20', '2026-08-21']);
  expect(await stored(page)).toEqual([]);
});

test('a server error or a refusal keeps the reading queued (removed only on success)', async ({ page, request }) => {
  const id = await plant(request);
  for (const [status, body] of [[503, '{}'], [422, JSON.stringify({ detail: 'That value is not possible.' })]]) {
    await page.unroute('**/readings').catch(() => {});
    await page.route('**/readings', (route) => route.fulfill({ status, contentType: 'application/json', body }));
    const answered = page.waitForResponse((r) => r.url().endsWith('/readings') && r.request().method() === 'POST');
    await open(page, id, [['2026-08-20', 9.9]]);
    await answered;
    await page.waitForTimeout(400);
    expect(await stored(page), `${status}`).toEqual(['2026-08-20']);
    await page.evaluate(() => localStorage.clear());  // the next case starts from nothing, so a leftover cannot answer for it
  }
});

test('Forget with readings waiting names them and deletes them only after the owner confirms; without any, the extra line is absent', async ({ page, request }) => {
  const id = await plant(request);
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));
  await open(page, id, [['2026-08-20', 9.9], ['2026-08-21', 8.8]], '#today');
  await page.waitForTimeout(800);  // the flush on load is refused (offline) and the readings stay
  let said = '';
  page.once('dialog', (d) => { said = d.message(); d.dismiss(); });
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect.poll(() => said).toContain("2 readings haven't been saved yet. Forgetting will delete them from this device.");
  expect(said).toContain('this browser only');  // the existing honesty wording is still there
  expect(await stored(page)).toEqual(['2026-08-20', '2026-08-21']);  // Cancel: nothing deleted
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  // no readings waiting: the dialog has no such line
  await page.unroute('**/readings');
  await open(page, id, [], '#today');
  let plain = '';
  page.once('dialog', (d) => { plain = d.message(); d.dismiss(); });
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect.poll(() => plain).toContain('this browser only');
  expect(plain).not.toContain("haven't been saved yet");
});

test('Forget with one waiting reading, in Hindi and Punjabi, says so in that language', async ({ page, request }) => {
  const id = await plant(request);
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));
  for (const [lang, name, text] of [['hi', 'हिन्दी', 'रीडिंग अभी सेव नहीं हुई है'], ['pa', 'ਪੰਜਾਬੀ', 'ਰੀਡਿੰਗ ਹਾਲੇ ਸੇਵ ਨਹੀਂ ਹੋਈ']]) {
    await open(page, id, [['2026-08-20', 9.9]], '#today');
    await page.getByRole('button', { name }).click();
    let said = '';
    page.once('dialog', (d) => { said = d.message(); d.dismiss(); });
    await page.locator('#forget').click();
    await expect.poll(() => said, lang).toContain(text);
  }
});

test('a mix: the fresh day is sent, the day the server holds stays queued for review', async ({ page, request }) => {
  const id = await plant(request);
  const sent = posts(page);
  await open(page, id, [['2026-08-05', 5.9], ['2026-08-20', 9.9]]);
  await expect.poll(() => stored(page)).toEqual(['2026-08-05']);
  expect(sent).toEqual(['2026-08-20']);
  await expect(page.locator('#queue')).toContainText('1 reading waiting, review');
});

test('a reading the server refused is remembered as refused and is not sent again by itself; Try now sends it', async ({ page, request }) => {
  const id = await plant(request);
  let refuse = true;
  const sent = [];
  await page.route('**/readings', (route) => {
    sent.push(route.request().postDataJSON().date);
    if (refuse) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'That value is not possible.' }) });
    return route.continue();
  });
  await open(page, id, [['2026-08-20', 9.9]]);
  await expect.poll(() => sent.length).toBe(1);
  await expect(page.locator('#queue')).toContainText('review');
  await page.reload();  // a new page load: the refusal is remembered with the reading
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(600);
  expect(sent, 'not sent again on load or on the online event').toEqual(['2026-08-20']);
  await expect(page.locator('#queue')).toContainText('1 reading waiting, review');
  refuse = false;
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.locator('#queue')).toBeHidden();
  expect(sent).toEqual(['2026-08-20', '2026-08-20']);
});

test('a reading that already landed (same value on the server, only the answer was lost) is dropped without being sent again', async ({ page, request }) => {
  const id = await plant(request);
  const sent = posts(page);
  await open(page, id, [['2026-08-05', 5.4]]);  // the server has exactly 5.4 for that day
  await expect(page.locator('#queue')).toBeHidden();
  expect(sent).toEqual([]);
  expect(await stored(page)).toEqual([]);
});

test('Forget leaves another plant\'s waiting readings alone', async ({ page, request }) => {
  const id = await plant(request);
  const other = await plant(request);
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, [
    { site: id, body: { date: '2026-08-20', kwh: 9.9, kind: 'daily' } }, { site: other, body: { date: '2026-08-21', kwh: 8.8, kind: 'daily' } }]]);
  await page.goto(`/?site=${id}#today`);
  await page.waitForTimeout(600);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect.poll(async () => (await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), KEY)).map((q) => q.site)).toEqual([other]);
});

test('a saved copy of the old default factor (0.675 under version 22.0) falls back to the current default; a typed figure is kept', async ({ page, request }) => {
  const id = await plant(request);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('surya-audit-assumptions', JSON.stringify({ tariff: 7, co2: 0.675, cea_version: '22.0', factor_type: 'weighted average, including imports, FY 2025-26' })));
  await page.goto(`/?site=${id}#today`);
  await expect(page.locator('#co2-line')).toContainText('at 0.71 kg per unit (assumption)');
  await page.evaluate(() => localStorage.setItem('surya-audit-assumptions', JSON.stringify({ tariff: 7, co2: 0.9, cea_version: '', factor_type: '' })));
  await page.goto(`/?site=${id}&again=1#today`);
  await expect(page.locator('#co2-line')).toContainText('at 0.9 kg per unit (assumption)');
});
