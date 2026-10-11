// Performance and usability on a poor network (master prompt v4): the saved result is drawn first and never shown as current, a read is
// retried, a write is not, a timed-out save is looked up before anything else, and a flaky network never loses data or locks the page.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function plant(request, rows) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of rows ? lines.slice(0, rows) : lines) {
    const [date, kwh, kind] = line.split(',');
    expect((await request.post(`/api/sites/${id}/readings`, { data: { date, kwh: Number(kwh), kind: kind || 'daily' } })).ok()).toBeTruthy();
  }
  return id;
}
const keyFor = (id) => `surya-audit-last:${id}`;

test('saved result: drawn first and labelled, replaced when the refresh succeeds, kept with Try again when it fails, cleared by Forget', async ({ page, request }) => {
  const id = await plant(request);
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  await expect(page.locator('#saved-note')).toBeHidden();  // a fresh result is never labelled saved
  expect(await page.evaluate((k) => Boolean(localStorage.getItem(k)), keyFor(id))).toBe(true);

  // A slow server: the saved result is on screen at once, with its label, and no skeleton.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/sites/*/audit', async (route) => { await gate; await route.continue(); });
  await page.goto(`/?site=${id}&slow=1`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  await expect(page.locator('#saved-note')).toHaveText(/^Saved result from .+, refreshing\.\.\.$/);
  await expect(page.locator('#skeleton')).toBeHidden();
  release();
  await expect(page.locator('#saved-note')).toBeHidden();  // replaced by the fresh result
  await page.unroute('**/api/sites/*/audit');

  // The server fails: the saved result stays, says it is not current, and offers Try again; pressing it with the server back refreshes.
  await page.route('**/api/sites/*/audit', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto(`/?site=${id}&failing=1`);
  await expect(page.locator('#saved-note')).toHaveText(/^Could not refresh\. This is the saved result from .+\.$/, { timeout: 15000 });
  await expect(page.locator('#headline .ring')).toBeVisible();
  await expect(page.locator('#retry')).toBeVisible();
  await page.unroute('**/api/sites/*/audit');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#saved-note')).toBeHidden();
  await expect(page.locator('#retry')).toBeHidden();

  // With nothing saved the skeleton shows instead.
  await page.evaluate((k) => localStorage.removeItem(k), keyFor(id));
  const gate2 = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/sites/*/audit', async (route) => { await gate2; await route.continue(); });
  await page.goto(`/?site=${id}&empty=1`);
  await expect(page.locator('#skeleton')).toBeVisible();
  await expect(page.locator('#saved-note')).toBeHidden();
  release();
  await expect(page.locator('#headline .ring')).toBeVisible();
  await page.unroute('**/api/sites/*/audit');

  // Forget clears it with the plant.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), keyFor(id))).toBeNull();
});

test('saved result: a copy of the wrong shape is ignored and a missing plant clears it', async ({ page, request }) => {
  const id = await plant(request, 3);
  await page.goto('/');
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [keyFor(id), JSON.stringify({ savedAt: Date.now(), audit: { timeline: 'x' } })]);
  await page.goto(`/?site=${id}&bad=1`);
  await expect(page.locator('#headline')).toBeVisible();
  await expect(page.locator('#saved-note')).toBeHidden();
  // A plant the server no longer knows: its saved copy goes, and the owner is told.
  await page.evaluate(([k, v]) => { localStorage.removeItem('surya-audit-site'); localStorage.setItem(k, v); }, [keyFor('gone'), JSON.stringify({ savedAt: Date.now(), audit: { timeline: [] } })]);  // no remembered plant to fall back to
  await page.goto('/?site=gone&x=1');
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), keyFor('gone'))).toBeNull();
});

test('a read is tried again, a write is not: two failed audit reads then success; a failed save is not repeated by the page', async ({ page, request }) => {
  const id = await plant(request, 3);
  let reads = 0;
  await page.route('**/api/sites/*/audit', (route) => { reads += 1; if (reads <= 2) route.abort('connectionreset'); else route.continue(); });
  await page.goto(`/?site=${id}&retry=1`);
  await expect(page.locator('#headline .ring')).toBeVisible({ timeout: 15000 });
  expect(reads).toBe(3);  // the first try and two more
  await page.unroute('**/api/sites/*/audit');
  let writes = 0;
  await page.route('**/api/sites/*/readings', (route) => { writes += 1; route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); });
  await page.getByRole('tab', { name: /Log/ }).click();
  await page.locator('input[name=kwh]').fill('9.5');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#error')).toBeVisible();
  await page.waitForTimeout(5000);
  expect(writes).toBe(1);  // never repeated on its own
  await expect(page.locator('input[name=kwh]')).toHaveValue('9.5');  // the typed value is still there
});

test('a save that times out is looked up first: saved means success, not saved means the owner is told and keeps the value', async ({ page, request }) => {
  const id = await plant(request, 3);
  await page.clock.install();
  await page.goto(`/?site=${id}&clock=1`);
  await expect(page.locator('#headline')).toBeVisible();
  await page.getByRole('tab', { name: /Log/ }).click();
  const day = await page.locator('input[name=date]').inputValue();
  let landOnTheServer = true;
  await page.route('**/api/sites/*/readings', async (route) => {
    if (landOnTheServer) await request.post(`/api/sites/${id}/readings`, { data: route.request().postDataJSON() });  // saved, but the answer never comes
    // never fulfilled: the page's own timeout ends the wait
  });
  await page.locator('input[name=kwh]').fill('7.7');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();  // pending text on the button
  await page.clock.fastForward(21000);
  await expect(page.locator('#status')).toContainText('Saved the reading');  // found on the server: a success, no error, no queue
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#queue')).toBeHidden();
  expect(day).toBeTruthy();

  // Not on the server: nothing is queued behind the owner's back, and the value stays for another try.
  landOnTheServer = false;
  await page.route('**/api/sites/*/readings', async () => { /* hangs */ });
  page.once('dialog', (dialog) => dialog.accept());  // the day now has a reading: replace it?
  await page.locator('input[name=kwh]').fill('6.6');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await page.clock.fastForward(21000);
  await expect(page.locator('#error')).toContainText('did not answer in time and the reading was not saved');
  await expect(page.locator('#queue')).toBeHidden();
  await expect(page.locator('input[name=kwh]')).toHaveValue('6.6');
});

test('a flaky network (3 in 10 reads fail, some are slow): the shell stays usable, the saved result stays, errors offer Try again, no data is lost', async ({ page, request }) => {
  const id = await plant(request);
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let n = 0;
  await page.route('**/api/**', async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    n += 1;
    if (n % 10 < 3) { await route.abort('connectionreset'); return; }
    if (n % 10 === 5) await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  for (let i = 0; i < 6; i++) {
    await page.goto(`/?site=${id}&flaky=${i}`);
    // The shell and the saved (or fresh) result are there at once, whatever the network does.
    await expect(page.locator('#headline .ring')).toBeVisible();
    await page.getByRole('tab', { name: /Why/ }).click();
    await expect(page.locator('#chart svg')).toBeVisible();
    await page.getByRole('tab', { name: /Today/ }).click();
    if (await page.locator('#retry').isVisible()) {
      await expect(page.locator('#error')).toBeVisible();  // an error says what happened
      await page.getByRole('button', { name: 'Try again' }).click();
    }
  }
  // A reading typed while reads fail is saved by the write path and is in the audit afterwards.
  await page.getByRole('tab', { name: /Log/ }).click();
  await page.locator('input[name=kwh]').fill('8.1');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading');
  await page.unroute('**/api/**');
  const timeline = (await (await request.get(`/api/sites/${id}/audit`)).json()).timeline;
  expect(timeline.some((p) => Math.abs(p.kwh - 8.1) < 0.0005)).toBe(true);
  expect(errors).toEqual([]);
});

test('first visit: nothing shifts while the page loads (layout shift under 0.1), even when the audit is slow', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });  // a phone: the footer would be on the first screen
  const id = await plant(request);
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/api/sites/*/audit', async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });
  await page.goto(`/?site=${id}&cls=1`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  await page.waitForTimeout(1500);  // late paints and the count-up
  expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.1);
});

test('a read that fails with a 4xx is not retried', async ({ page, request }) => {
  const id = await plant(request, 3);
  let reads = 0;
  await page.route('**/api/sites/*/audit', (route) => { reads += 1; route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'That request was not valid.' }) }); });
  await page.goto(`/?site=${id}&four=1`);
  await expect(page.locator('#error')).toContainText('That request was not valid.');
  await page.waitForTimeout(1500);
  expect(reads).toBe(1);
});

test('a slow refresh never overwrites a newer result: a reading saved while the read is on its way stays', async ({ page, request }) => {
  const id = await plant(request, 3);
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  const stale = await (await request.get(`/api/sites/${id}/audit`)).json();  // the audit as it is before the save
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/sites/*/audit', async (route) => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) }); });
  await page.goto(`/?site=${id}&race=1#log`);
  await expect(page.locator('#saved-note')).toBeVisible();  // the saved result is drawn while the read waits
  await page.locator('input[name=kwh]').fill('9.1');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading');
  const before = await page.evaluate(() => state.audit.timeline.length);
  release();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => state.audit.timeline.length), 'the late, older answer is dropped').toBe(before);
  expect(before).toBeGreaterThan(stale.timeline.length);
});

test('a save found on the server after a timeout also replaces the copy that was waiting in the queue', async ({ page, request }) => {
  const id = await plant(request, 3);
  await page.clock.install();
  await page.goto(`/?site=${id}&clock=2`);
  await page.getByRole('tab', { name: /Log/ }).click();
  await page.route('**/api/sites/*/readings', (route) => route.abort('internetdisconnected'));
  await page.locator('input[name=kwh]').fill('5.5');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#queue')).toBeVisible();
  await page.unroute('**/api/sites/*/readings');
  await page.route('**/api/sites/*/readings', async (route) => { await request.post(`/api/sites/${id}/readings`, { data: route.request().postDataJSON() }); /* the answer never comes */ });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('input[name=kwh]').fill('5.6');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await page.clock.fastForward(21000);
  await expect(page.locator('#status')).toContainText('Saved the reading');
  await expect(page.locator('#queue')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('surya-audit-queued-readings'))).toBeNull();
});

test('first visit in Hindi: nothing shifts either (the fonts come after the content)', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await plant(request);
  await page.addInitScript(() => {
    localStorage.setItem('surya-audit-lang', 'hi');
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/api/sites/*/audit', async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });
  await page.goto(`/?site=${id}&cls=hi`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__cls)).toBeLessThan(0.1);
});

test('the evidence panel says how many days had actual weather, and marks the line with "!" when not all did', async ({ page, request }) => {
  const id = await plant(request);
  const audit = await (await request.get(`/api/sites/${id}/audit`)).json();
  const known = audit.timeline.filter((p) => p.weather_known).length;
  await page.goto(`/?site=${id}`);
  const line = page.locator('#ev-lines li').filter({ hasText: /weather/i });
  await expect(line).toHaveCount(1);
  if (known) await expect(line).toContainText(`Actual weather known for ${known} of ${audit.timeline.length} readings`);
  else await expect(line).toContainText('Typical weather for the month, not the actual days');
  await expect(line.locator('.ev-mark')).toHaveText(known === audit.timeline.length ? '✓' : '!');
  // A synthetic plant's readings are not "confirmed by you".
  await expect(page.locator('#ev-lines')).not.toContainText('readings you confirmed');
  await expect(page.locator('#ev-lines')).toContainText(`${audit.timeline.length} readings (synthetic)`);
});
