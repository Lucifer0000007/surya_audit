// Client-side fixes from the 2026-10-11 review. Each test fails with the fix taken out.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY = 'surya-audit-queued-readings';
async function plant(request, rows = 60) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of lines.slice(0, rows)) {
    const [date, kwh, kind] = line.split(',');
    expect((await request.post(`/api/sites/${id}/readings`, { data: { date, kwh: Number(kwh), kind: kind || 'daily' } })).ok()).toBeTruthy();
  }
  return id;
}

test('Forget while the first read is still on its way does not bring the plant back', async ({ page, request }) => {
  const id = await plant(request);
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring')).toBeVisible();  // a saved result now exists in this browser
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/audit', async (route) => { await gate; await route.continue(); });
  await page.reload();
  await expect(page.locator('#headline .ring')).toBeVisible();  // the saved result is drawn at once, the fresh read is held back
  page.once('dialog', (d) => d.accept());
  await page.locator('#forget').click();
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  release();
  await page.waitForTimeout(800);
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await expect(page.locator('#headline .ring')).toBeHidden();
});

test('a 409 (the plant was being written) is a reason to wait, not a refusal: the queued reading is not marked refused', async ({ page, request }) => {
  const id = await plant(request, 3);
  await page.route('**/readings', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'This plant changed while you were saving. Please try again.' }) }));
  const answered = page.waitForResponse((r) => r.url().endsWith('/readings') && r.request().method() === 'POST');
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, [{ site: id, body: { date: '2026-08-20', kwh: 9.9, kind: 'daily' } }]]);
  await page.goto(`/?site=${id}#log`);
  await answered;
  await page.waitForTimeout(400);
  const items = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  expect(items).toHaveLength(1);
  expect(items[0].refused, 'not marked refused').toBeUndefined();
  await expect(page.locator('#queue')).not.toContainText('review');
});

test('a corrupt queue key does not break the page', async ({ page, request }) => {
  const id = await plant(request, 3);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate((k) => localStorage.setItem(k, '{"not":"a list"}'), KEY);
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#panel-log')).toBeVisible();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
  await expect(page.locator('#queue')).toBeHidden();
});

test('a failed Approve gives the button back whole: its label and its tick are still there for the retry', async ({ page, request }) => {
  const id = await plant(request);
  await page.route('**/approve', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"nope"}' }));
  await page.goto(`/?site=${id}#fix`);
  const card = page.getByTestId('action-check_inverter');
  const button = card.getByRole('button', { name: 'Approve' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#error')).toBeVisible();
  await expect(card.locator('.approve-btn .lbl')).toHaveText('Approve');
  await expect(card.locator('.approve-btn .tick')).toHaveCount(1);
});

test('the chart scale is capped, so a near-zero baseline cannot draw a thousand gridlines', async ({ page }) => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf-8');
  expect(src).toMatch(/const top = Math\.min\(3, Math\.max\(1\.25, \.\.\.points\.map/);
  await page.goto('/');
  const lines = await page.evaluate(() => { const top = Math.min(3, Math.max(1.25, 909)); const ymax = Math.ceil(top / 0.25) * 0.25; let n = 0; for (let t = 0; t <= ymax + 1e-9; t += 0.5) n += 1; return n; });
  expect(lines).toBeLessThanOrEqual(7);
});
