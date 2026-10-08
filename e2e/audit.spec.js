// Screen check: the owner loop on the page, against the offline API (fixtures, no Gemini key).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'local_screens');
// A valid 1x1 PNG: enough to exercise the photo path without any real image.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function syntheticRows() {
  const [header, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  const keys = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));
}

async function createSite(request, overrides = {}) {
  const body = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')), ...overrides };
  const res = await request.post('/api/sites', { data: body });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id;
}

async function postRows(request, id, rows) {
  for (const r of rows) {
    const res = await request.post(`/api/sites/${id}/readings`, { data: { date: r.date, kwh: Number(r.kwh), kind: r.kind || 'daily' } });
    expect(res.ok()).toBeTruthy();
  }
}

async function expectNoSideScroll(page) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
}

test('synthetic scenario: flagged dips, ranked causes, approve, complaint draft', async ({ page, request, baseURL }, testInfo) => {
  const outside = [];
  page.on('request', (req) => { if (!req.url().startsWith(baseURL)) outside.push(req.url()); });

  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);

  // Synthetic data is labelled on screen.
  await expect(page.getByText('Synthetic data', { exact: true })).toBeVisible();

  // Detect and classify: the fault is the top possible cause, with a confidence level, not a diagnosis.
  const headline = page.getByTestId('headline');
  await expect(headline).toContainText('Top possible cause: Sudden fault');
  await expect(headline).toContainText('high confidence');
  await expect(headline).toContainText('not a diagnosis');
  await expect(page.locator('#cause-list > li')).toHaveCount(4);
  await expect(page.locator('#cause-list > li').first()).toContainText('Sudden fault');

  // Timeline: 60 readings, the 5 fault days flagged as dips.
  await expect(page.locator('#chart path.bar')).toHaveCount(60);
  await expect(page.locator('#chart [data-dip="true"]')).toHaveCount(5);
  const chart = page.locator('#chart svg');
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#chart .tip')).toBeVisible();
  await expect(page.locator('#chart .tip')).toContainText('of usual');
  // Tapping (or clicking) the last bar shows that reading: a dip.
  const box = await chart.boundingBox();
  const spot = { x: box.width - 12, y: box.height / 2 };
  if (testInfo.project.use.hasTouch) await chart.tap({ position: spot });
  else await chart.click({ position: spot });
  await expect(page.locator('#chart .tip')).toContainText('Dip: below 85%');
  await page.getByText('Show readings as a table').click();
  await expect(page.locator('#table tbody tr')).toHaveCount(60);

  // The September cleaning suggestion was never approved, and dust is no longer rated above low.
  await expect(page.getByTestId('action-clean_panels')).toContainText('Earlier suggestion');

  // Act: the owner approves the suggestion; verification waits for the next readings.
  const check = page.getByTestId('action-check_inverter');
  await expect(check).toContainText('Waiting for your approval');
  await check.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('action-check_inverter')).toContainText('Checking the next readings');

  // Escalate: a draft the owner files themselves, with placeholders and the synthetic label.
  await page.getByRole('button', { name: 'Draft a complaint' }).click();
  const draft = page.getByLabel('Draft complaint');
  await expect(draft).toHaveValue(/^SYNTHETIC DATA/);
  await expect(draft).toHaveValue(/<<OWNER TO FILL: /);
  await expect(page.getByText('Nothing has been sent.', { exact: true })).toBeVisible();
  await expect(page.locator('#categories')).toContainText('SAMPLE');

  await expectNoSideScroll(page);
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-synthetic.png`), fullPage: true });
  expect(outside).toEqual([]);
});

test('owner sets up a plant and types a reading', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await page.getByLabel('Latitude').fill('26.85');
  await page.getByLabel('Longitude').fill('80.95');
  await page.getByLabel('Plant size (kW)').fill('3');
  await page.getByRole('button', { name: 'Start auditing' }).click();

  // No loss given: the SAMPLE value is called out. This plant is not synthetic.
  await expect(page.getByText('Sample values in use')).toBeVisible();
  await expect(page.getByText('Synthetic data', { exact: true })).toHaveCount(0);

  await page.getByLabel('Date').first().fill('2026-09-01');
  await page.getByLabel('Energy produced (kWh)').fill('11.5');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.getByTestId('headline')).toContainText('Still learning this plant');
  await expect(page.locator('#chart path.bar')).toHaveCount(1);

  // Saving the same date again asks first, then replaces the reading.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Energy produced (kWh)').fill('12.34');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading');
  await expect(page.locator('#chart path.bar')).toHaveCount(1);
  await page.getByText('Show readings as a table').click();
  await expect(page.locator('#table tbody tr')).toHaveText([/12\.3/]);

  // The site is remembered on this device.
  await page.reload();
  await expect(page.locator('#chart path.bar')).toHaveCount(1);

  await expectNoSideScroll(page);
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-first-reading.png`), fullPage: true });
});

test('photo reading falls back to typing when it is unavailable', async ({ page, request }) => {
  const id = await createSite(request);
  await page.goto(`/?site=${id}`);
  await expect(page.getByText('Your photo is sent to Google Gemini to read the numbers.')).toBeVisible();
  await page.locator('#photo').setInputFiles({ name: 'meter.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
  await expect(page.locator('#photo-note')).toContainText('type the reading by hand');
  await expect(page.locator('#photo-note')).toContainText('The photo was not saved.');

  // Nothing was saved by the photo; typing still works.
  await expect(page.locator('#chart path.bar')).toHaveCount(0);
  await page.getByLabel('Date').first().fill('2026-09-02');
  await page.getByLabel('Energy produced (kWh)').fill('10.2');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#chart path.bar')).toHaveCount(1);
  await expect(page.locator('#photo-review')).toBeHidden();
});

test('a stale link never forgets the plant this browser remembers', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#chart path.bar')).toHaveCount(2);

  await page.goto('/?site=no-such-plant');
  await expect(page.getByRole('alert')).toContainText('No plant was found for that link');
  await expect(page.locator('#chart path.bar')).toHaveCount(2);
  expect(new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.locator('#chart path.bar')).toHaveCount(2);
});
