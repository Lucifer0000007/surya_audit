// Screen check: the owner loop on the page, against the offline API (fixtures, no Gemini key).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'local_screens');
const TAB_NAMES = ['Today', 'Log', 'Fix', 'Why', 'Report'];
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

async function openTab(page, name) {
  // Chrome's phone emulation fakes a hiding URL bar: once the page has scrolled, the visual viewport
  // sits 126 px into the layout viewport and Playwright's hit test for the fixed bottom bar lands on
  // whatever is underneath (the browser's own elementFromPoint finds the tab). Keyboard activation
  // takes the same code path as a tap without depending on pointer geometry, and the
  // "tabs" test covers pointer clicks on a desktop viewport.
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

// Walks the three-step setup wizard with the synthetic site's values (no loss given, so sample=true).
async function setupPlant(page) {
  await page.getByLabel('Latitude').fill('26.85');
  await page.getByLabel('Longitude').fill('80.95');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Plant size (kW)').fill('3');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Start auditing' }).click();
}

async function expectNoSideScroll(page) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
}

// Counts document.startViewTransition calls, so tests can tell whether tab changes used it.
async function countViewTransitions(page) {
  await page.addInitScript(() => {
    window.__viewTransitions = 0;
    if (document.startViewTransition) {
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (cb) => { window.__viewTransitions += 1; return original(cb); };
    }
  });
}

const animationOf = (locator, pseudo) => locator.first().evaluate((n, p) => getComputedStyle(n, p).animationName, pseudo || null);

test('synthetic scenario: flagged dips, ranked causes, approve, complaint draft', async ({ page, request, baseURL }, testInfo) => {
  const outside = [];
  page.on('request', (req) => { if (!req.url().startsWith(baseURL)) outside.push(req.url()); });

  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);

  // Synthetic data is labelled on screen, above the tabs.
  await expect(page.getByText('Synthetic data', { exact: true })).toBeVisible();

  // Today: the fault is the top possible cause, with a confidence level, not a diagnosis.
  const headline = page.getByTestId('headline');
  await expect(headline).toBeVisible();
  await expect(headline).toContainText('Top possible cause: Sudden fault');
  await expect(headline).toContainText('high confidence');
  await expect(headline).toContainText('not a diagnosis');
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-today.png`), fullPage: true });

  // Why: 60 readings, the 5 fault days flagged as dips, and the ranked causes.
  await openTab(page, 'Why');
  await expect(page.locator('#cause-list > li')).toHaveCount(4);
  await expect(page.locator('#cause-list > li').first()).toContainText('Sudden fault');
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
  // The synthetic scenario can be replayed day by day.
  await page.getByRole('button', { name: 'Replay the 60 days' }).click();
  await expect(page.locator('#replay-caption')).toContainText('Day ');
  await page.getByRole('button', { name: 'Stop replay' }).click();
  await expect(page.locator('#chart path.bar:not(.hold)')).toHaveCount(60);
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-why.png`), fullPage: true });

  // Fix: the September cleaning suggestion was never approved, and dust is no longer rated above low.
  await openTab(page, 'Fix');
  await expect(page.getByTestId('action-clean_panels')).toContainText('Earlier suggestion');
  // Act: the owner approves the suggestion; verification waits for the next readings.
  const check = page.getByTestId('action-check_inverter');
  await expect(check).toContainText('Waiting for your approval');
  await expect(check.locator('[aria-current="step"]')).toContainText('Waiting');
  await check.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('action-check_inverter')).toContainText('Checking the next readings');
  await expect(page.getByTestId('action-check_inverter').locator('[aria-current="step"]')).toContainText('Checking');
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-fix.png`), fullPage: true });

  // Report: a draft the owner files themselves, with placeholders and the synthetic label.
  await openTab(page, 'Report');
  await page.getByRole('button', { name: 'Draft a complaint' }).click();
  const draft = page.getByLabel('Draft complaint');
  await expect(draft).toHaveValue(/^SYNTHETIC DATA/);
  await expect(draft).toHaveValue(/<<OWNER TO FILL: /);
  await expect(page.getByText('Nothing has been sent.', { exact: true })).toBeVisible();
  await expect(page.locator('#categories')).toContainText('SAMPLE');

  await expectNoSideScroll(page);
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-report.png`), fullPage: true });
  expect(outside).toEqual([]);
});

test('owner sets up a plant and types a reading', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);  // no tabs before there is a plant
  await setupPlant(page);

  // No loss given: the SAMPLE value is called out. This plant is not synthetic.
  await expect(page.getByText('Sample values in use')).toBeVisible();
  await expect(page.getByText('Synthetic data', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');

  await openTab(page, 'Log');
  await page.getByLabel('Date').first().fill('2026-09-01');
  await page.getByLabel('Energy produced (kWh)').fill('11.5');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.getByTestId('headline')).toContainText('Still learning this plant');

  // Saving the same date again asks first, then replaces the reading.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Energy produced (kWh)').fill('12.34');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading');
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(1);
  await page.getByText('Show readings as a table').click();
  await expect(page.locator('#table tbody tr')).toHaveText([/12\.3/]);

  // The site and the open tab are remembered across a reload.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Why', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chart path.bar')).toHaveCount(1);

  await expectNoSideScroll(page);
  await page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-first-reading.png`), fullPage: true });
});

test('photo reading falls back to typing when it is unavailable', async ({ page, request }) => {
  const id = await createSite(request);
  await page.goto(`/?site=${id}#log`);
  await expect(page.getByText('Your photo is sent to Google Gemini to read the numbers.')).toBeVisible();
  await page.locator('#photo').setInputFiles({ name: 'meter.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
  await expect(page.locator('#photo-note')).toContainText('type the reading by hand');
  await expect(page.locator('#photo-note')).toContainText('The photo was not saved.');

  // Nothing was saved by the photo; typing still works.
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(0);
  await openTab(page, 'Log');
  await page.getByLabel('Date').first().fill('2026-09-02');
  await page.getByLabel('Energy produced (kWh)').fill('10.2');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#photo-review')).toBeHidden();
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(1);
});

test('a stale link never forgets the plant this browser remembers', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}#why`);
  await expect(page.locator('#chart path.bar')).toHaveCount(2);

  await page.goto('/?site=no-such-plant');
  await expect(page.getByRole('alert')).toContainText('No plant was found for that link');
  expect(new URL(page.url()).search).toBe('');
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('#chart path.bar')).toHaveCount(2);
});

test('tabs: ARIA, keyboard, URL hash, Back, reload and honesty flags on every tab', async ({ page, request }, testInfo) => {
  await countViewTransitions(page);
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}#why`);

  // A plant link with a tab in its hash lands on that tab.
  await expect(page.getByRole('tab')).toHaveCount(5);
  await expect(page.getByRole('tab', { name: 'Why', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-why')).toBeVisible();
  await expect(page.locator('#chart path.bar')).toHaveCount(60);
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  for (const name of ['today', 'log', 'fix', 'why', 'report']) {
    await expect(page.locator(`#tab-${name}`)).toHaveAttribute('aria-controls', `panel-${name}`);
    await expect(page.locator(`#panel-${name}`)).toHaveAttribute('aria-labelledby', `tab-${name}`);
    await expect(page.locator(`#panel-${name}`)).toHaveAttribute('role', 'tabpanel');
  }

  // Clicking a tab puts it in the URL; Back returns to the previous tab. (A real pointer click here
  // on desktop; on the phone project the bottom bar is activated via keyboard, see openTab.)
  if (testInfo.project.use.hasTouch) await openTab(page, 'Fix');
  else await page.getByRole('tab', { name: 'Fix', exact: true }).click();
  await expect(page).toHaveURL(/#fix$/);
  await expect(page.locator('#panel-fix')).toBeVisible();
  await expect(page.locator('#panel-why')).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/#why$/);
  await expect(page.getByRole('tab', { name: 'Why', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Arrow keys move focus and selection (roving tabindex); Home and End jump; arrows wrap.
  await page.getByRole('tab', { name: 'Why', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Report', exact: true })).toBeFocused();
  await expect(page).toHaveURL(/#report$/);
  await expect(page.locator('#tab-report')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#tab-why')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Report', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Report', exact: true })).toBeFocused();

  // A reload stays on the same tab.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Report', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-report')).toBeVisible();

  // Honesty flags stay visible whichever tab is open.
  for (const name of TAB_NAMES) {
    await openTab(page, name);
    await expect(page.getByText('Synthetic data', { exact: true })).toBeVisible();
    await expect(page.getByText('Sample values in use')).toBeVisible();
    await expect(page.getByText('Possible causes with confidence levels, not a diagnosis.')).toBeVisible();
    await expect(page.locator('#sources')).toContainText('retrieved');
    await expectNoSideScroll(page);
  }

  // With motion allowed, tab changes use view transitions and the logo rays turn.
  expect(await page.evaluate(() => window.__viewTransitions)).toBeGreaterThan(0);
  expect(await animationOf(page.locator('.rays'))).toBe('spin');
});

test('reduced motion: no animations, no view transitions, final values at once', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await countViewTransitions(page);
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  const audit = await (await request.get(`/api/sites/${id}/audit`)).json();
  const last = audit.timeline[audit.timeline.length - 1];
  await page.goto(`/?site=${id}`);

  // The headline number is final at once (no count-up) and nothing is animated.
  await expect(page.locator('#headline .ring-num')).toHaveText(`${Math.round(last.relative * 100)}%`);
  expect(await animationOf(page.locator('.rays'))).toBe('none');
  expect(await animationOf(page.locator('#headline .dots i.on'), '::after')).toBe('none');
  const arcTransition = await page.locator('#headline .gauge-arc').evaluate((n) => getComputedStyle(n).transitionDuration);
  expect(arcTransition).toBe('0s');

  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(60);
  expect(await page.locator('#chart svg').getAttribute('class')).toBeNull();
  expect(await animationOf(page.locator('#chart .bar'))).toBe('none');
  expect(await animationOf(page.locator('#panel-why > .card'))).toBe('none');
  await openTab(page, 'Fix');
  await openTab(page, 'Report');
  expect(await page.evaluate(() => window.__viewTransitions)).toBe(0);
});

test('a mangled link hash, a leftover hash on setup, and Enter during the Approve tick are all harmless', async ({ page, request }) => {
  // 1. A share link whose fragment is not valid percent-encoding still opens the plant and its tabs.
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 3));
  await page.goto(`/?site=${id}#%`);
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('alert')).toBeHidden();
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(3);

  // 2. Setting up a plant from a URL that still carries another plant's id and a tab starts clean on Today.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?site=no-such-plant-either#why`);
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await setupPlant(page);
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/#today$/);
  expect(new URL(page.url()).search).toBe('');

  // 3. Enter on the Approve button while its tick shows does not post a second approval.
  const id2 = await createSite(request);
  await postRows(request, id2, syntheticRows());
  await page.goto(`/?site=${id2}#fix`);
  const check = page.getByTestId('action-check_inverter');
  const approve = check.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeVisible();  // the Fix panel is un-hidden inside the view transition callback
  await approve.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('action-check_inverter')).toContainText('Checking the next readings');
  await expect(page.getByRole('alert')).toBeHidden();
});

test('impact strip: sourced editable assumptions, payback only for dust, water, kWh chart, WhatsApp share', async ({ page, request }) => {
  const id = await createSite(request);
  const rows = syntheticRows();
  // Mid-scenario, dust is the top cause: the cleaning payback line shows.
  await postRows(request, id, rows.slice(0, 42));
  await page.goto(`/?site=${id}`);
  const impact = page.getByTestId('impact');
  await expect(impact).toBeVisible();
  await expect(impact).toContainText('What the dips cost');
  await expect(impact.locator('.tag').first()).toHaveText('estimate');
  await expect(impact).toContainText('Units lost in the dips');
  await expect(impact).toContainText('flagged as dips');
  await expect(impact).toContainText('at Rs 7 per unit');
  await expect(impact).toContainText('at 0.675 kg per unit');
  // Dust is suspected but no day has crossed the dip line yet: the clean's cost is shown, no payback invented.
  await expect(impact).toContainText('0 flagged as dips');
  await expect(impact).toContainText('A clean costs about');
  await expect(impact).toContainText('no daily loss to set against it');
  await expect(impact).toContainText('not a promise');
  await expect(impact).not.toContainText('n/a');
  await expect(impact).toContainText('less than that schedule');
  // Every default is labelled an assumption and has a source link with a retrieval date.
  await impact.getByText('How we calculated this').click();
  await expect(impact.locator('label .tag')).toHaveCount(6);
  await expect(impact).toContainText('retrieved 2026-10-08');
  await expect(impact.locator('#assume-sources a')).toHaveCount(8);  // every quoted figure links to its document
  await expect(impact).toContainText('CEA');
  // After the fault: 5 flagged dips carry a real loss; dust is no longer supported, so no payback line.
  await postRows(request, id, rows.slice(42));
  await page.reload();
  await expect(page.getByTestId('impact')).toBeVisible();
  await expect(page.getByTestId('impact')).toContainText('5 flagged as dips');
  await expect(page.getByTestId('impact')).not.toContainText('pays back');
  await expect(page.getByTestId('impact')).toContainText('none suggested by the audit yet');
  // Editing the tariff doubles the rupee figure; reset restores the default.
  const money = () => page.getByTestId('impact').locator('.stat').nth(1).locator('.value').textContent();
  const before = Number((await money()).replace(/[^0-9]/g, ''));
  expect(before).toBeGreaterThan(0);
  await page.getByTestId('impact').getByText('How we calculated this').click();
  await page.getByTestId('impact').getByLabel(/Tariff, Rs per unit/).fill('14');
  await page.getByRole('button', { name: 'Use these values' }).click();
  await expect(page.getByTestId('impact')).toContainText('at Rs 14 per unit');
  const after = Number((await money()).replace(/[^0-9]/g, ''));
  expect(Math.abs(after - 2 * before)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(page.getByTestId('impact')).toContainText('at Rs 14 per unit');  // remembered on this device
  await page.getByTestId('impact').getByText('How we calculated this').click();
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByTestId('impact')).toContainText('at Rs 7 per unit');

  // Why: the kWh chart has both series and marks the 5 dips.
  await openTab(page, 'Why');
  await expect(page.locator('#kwh-chart polyline.expected')).toHaveCount(1);
  await expect(page.locator('#kwh-chart polyline.actual')).toHaveCount(1);
  await expect(page.locator('#kwh-chart .actual-dot')).toHaveCount(5);
  await expect(page.locator('#kwh-legend')).toContainText('Expected (kWh)');

  // WhatsApp share: a wa.me link carrying the verdict (and the synthetic label), nothing sent.
  await openTab(page, 'Today');
  const share = page.locator('#share-verdict');
  await expect(share).toHaveAttribute('target', '_blank');
  const href = decodeURIComponent(await share.getAttribute('href'));
  expect(href.startsWith('https://wa.me/?text=')).toBe(true);
  expect(href).toContain('SYNTHETIC DEMO DATA');
  expect(href).toContain('Top possible cause: Sudden fault (high confidence). A possible cause, not a diagnosis.');
  await openTab(page, 'Report');
  await page.getByRole('button', { name: 'Draft a complaint' }).click();
  const draftShare = page.locator('#share-draft');
  await expect(draftShare).toBeVisible();
  // The click sets the href from the (editable) draft; prevent navigation and read it.
  await page.evaluate(() => document.getElementById('share-draft').addEventListener('click', (e) => e.preventDefault()));
  await draftShare.click();
  const draftHref = decodeURIComponent(await draftShare.getAttribute('href'));
  expect(draftHref.startsWith('https://wa.me/?text=')).toBe(true);
  expect(draftHref).toContain('<<OWNER TO FILL: ');
  expect(draftHref).toContain('SYNTHETIC DATA');
  await expect(page.locator('#status')).toContainText('Nothing has been sent by this page');
});

test('a plant with no dips shows zero loss, not a bill for ordinary variation', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 20));
  await page.goto(`/?site=${id}`);
  const impact = page.getByTestId('impact');
  await expect(impact).toBeVisible();
  await expect(impact).toContainText('0 flagged as dips');
  await expect(impact.locator('.stat').nth(0).locator('.value')).toHaveText('0 kWh');
  await expect(impact.locator('.stat').nth(1).locator('.value')).toHaveText('₹0');
  await expect(impact).not.toContainText('pays back');
  // The shared verdict carries the SAMPLE label when a sample loss value is in use.
  const href = decodeURIComponent(await page.locator('#share-verdict').getAttribute('href'));
  expect(href).toContain('SAMPLE system-loss value');
});

test('offline: a reading waits in this browser and is saved when the connection returns', async ({ page, request, context }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}#log`);
  await context.setOffline(true);
  await page.getByLabel('Date').first().fill('2026-08-20');
  await page.getByLabel('Energy produced (kWh)').fill('9.9');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#queue')).toContainText('Offline: 1 reading will be saved when you are connected');
  await expect(page.locator('#status')).toContainText('will be saved when you are connected');
  // Queued items keep the overwrite confirmation.
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('waiting to be saved'); dialog.accept(); });
  await page.getByLabel('Date').first().fill('2026-08-20');
  await page.getByLabel('Energy produced (kWh)').fill('10.1');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#queue')).toContainText('1 reading');
  // The queue lives in this browser: it survives a reload even while offline.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('surya-audit-queued-readings')))).toHaveLength(1);
  // Nothing reached the server yet.
  expect((await (await request.get(`/api/sites/${id}/audit`)).json()).timeline).toHaveLength(2);
  // Back online: the online event alone sends it, with the replacement value, and the chip goes away.
  await context.setOffline(false);
  await expect(page.locator('#status')).toContainText('Saved the waiting reading.');
  await expect(page.locator('#queue')).toBeHidden();
  const saved = (await (await request.get(`/api/sites/${id}/audit`)).json()).timeline;
  expect(saved.map((p) => `${p.date}:${p.kwh}`)).toContain('2026-08-20:10.1');
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(3);
});

test('languages: Hindi and Punjabi interface, units not kWh, fonts inline, honesty text translated, no overflow', async ({ page, request, baseURL }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);
  // The fonts are carried by the page: no request leaves for them.
  const outside = [];
  page.on('request', (req) => { if (!req.url().startsWith(baseURL)) outside.push(req.url()); });

  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('tab', { name: 'आज', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('light')).toContainText('सुझाव देखें');  // the fault day: well below usual
  await expect(page.getByTestId('light')).toContainText('निदान नहीं');
  await expect(page.getByTestId('headline')).toContainText('यूनिट');
  await expect(page.getByTestId('headline')).not.toContainText('kWh');
  await expect(page.getByTestId('headline')).toContainText('अपेक्षित 15.1 यूनिट। गिरावट: सामान्य के 85% से नीचे।');  // Hindi word order and sentence stops
  await expect(page.getByLabel('बनी बिजली (यूनिट)', { exact: true })).toHaveAttribute('name', 'kwh');  // the field's name is its label alone, not the mic's
  const shared = decodeURIComponent(await page.locator('#share-verdict').getAttribute('href'));
  expect(shared).toContain('सबसे संभावित कारण');
  expect(shared).toContain('SYNTHETIC');
  expect(shared).not.toContain('Top possible cause');
  await expect(page.locator('footer')).toContainText('निदान नहीं');
  await expect(page.locator('footer')).toContainText('अप्रमाणित');
  // The honesty banners are translated but keep their labels; the SAMPLE word survives.
  await expect(page.getByText('नकली (synthetic) डेटा')).toBeVisible();
  await expect(page.locator('#banners')).toContainText('SAMPLE');
  expect(await page.evaluate(() => document.fonts.check('16px "Surya Indic"', 'सूर्य'))).toBe(true);
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'ਪੰਜਾਬੀ' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pa');
  await expect(page.getByRole('tab', { name: 'ਅੱਜ', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('light')).toContainText('ਨਿਦਾਨ ਨਹੀਂ');
  await expect(page.getByTestId('headline')).toContainText('ਯੂਨਿਟ');
  expect(await page.evaluate(() => document.fonts.check('16px "Surya Indic"', 'ਸੂਰਜ'))).toBe(true);
  for (const name of ['ਰੀਡਿੰਗ', 'ਹੱਲ', 'ਕਿਉਂ', 'ਸ਼ਿਕਾਇਤ']) {
    await page.getByRole('tab', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expectNoSideScroll(page);
  }
  // Server-written detail stays English and the page says so; the suggestion names are translated.
  await page.getByRole('tab', { name: 'ਹੱਲ', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('action-check_inverter')).toContainText('ਇਨਵਰਟਰ ਜਾਂਚੋ');
  await expect(page.getByTestId('action-check_inverter')).toContainText('ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ');
  await expect(page.getByTestId('action-check_inverter').locator('p[lang="en"]')).toHaveCount(1);  // the English suggestion is marked for screen readers
  await expect(page.getByTestId('action-check_inverter').getByRole('button', { name: 'ਮਨਜ਼ੂਰ' })).toBeVisible();
  // The Report tab's own callouts and status are translated; the draft itself stays English.
  await page.getByRole('tab', { name: 'ਸ਼ਿਕਾਇਤ', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'ਸ਼ਿਕਾਇਤ ਦਾ ਖਰੜਾ ਬਣਾਓ' }).click();
  await expect(page.locator('#draft-out')).toContainText('ਕੁਝ ਭੇਜਿਆ ਨਹੀਂ ਗਿਆ।');
  await expect(page.locator('#status')).toHaveText('ਖਰੜਾ ਤਿਆਰ। ਕੁਝ ਭੇਜਿਆ ਨਹੀਂ ਗਿਆ।');
  await expect(page.locator('#draft-text')).toHaveValue(/OWNER TO FILL/);

  // The choice is remembered, and English comes back.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pa');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toBeVisible();
  expect(outside).toEqual([]);
});

test('traffic light: shape and sentence before numbers; learning, fine and bad states', async ({ page, request }) => {
  const id = await createSite(request);
  const rows = syntheticRows();
  await postRows(request, id, rows.slice(0, 3));
  await page.goto(`/?site=${id}`);
  const light = page.getByTestId('light');
  await expect(light).toContainText('Still learning');
  await expect(light.locator('.light')).toHaveClass(/learning/);
  // The light card comes before the headline numbers in the DOM.
  const order = await page.evaluate(() => document.getElementById('light-card').compareDocumentPosition(document.getElementById('headline')));
  expect(order & 4).toBeTruthy();  // DOCUMENT_POSITION_FOLLOWING

  await postRows(request, id, rows.slice(3, 20));
  await page.reload();
  await expect(light).toContainText('looks fine');
  await expect(light).not.toContainText('possible cause');  // the cause line belongs to the dip state
  await expect(light.locator('.light')).toHaveClass(/\bok\b/);
  expect(await light.locator('.light-icon circle').count()).toBeGreaterThan(0);

  await postRows(request, id, rows.slice(20));
  await page.reload();
  await expect(light).toContainText('well below usual');
  await expect(light).toContainText('A possible cause: Sudden fault (high confidence). A possible cause, not a diagnosis.');
  await expect(light.locator('.light')).toHaveClass(/bad/);
  expect(await light.locator('.light-icon path').count()).toBeGreaterThanOrEqual(2);  // cloud + exclamation: a different shape

  // A 61st reading: the charts show the latest 60 and the subtitle says so (the table lists all).
  await postRows(request, id, [{ date: '2026-10-04', kwh: '7', kind: 'daily' }]);
  await page.reload();
  await openTab(page, 'Why');
  await expect(page.locator('#tl-sub')).toContainText('Showing the latest 60 of 61; the table lists all.');
  await expect(page.locator('#chart path.bar')).toHaveCount(60);

  // A very dim last day is shown but not judged: the light says so, never "fine" or a cause.
  const full = (await (await request.get(`/api/sites/${id}/audit`)).json()).timeline;
  const dim = full.filter((p) => p.low_sun).pop();
  expect(dim).toBeTruthy();
  const id2 = await createSite(request);
  await postRows(request, id2, rows.filter((r) => r.date <= dim.date));
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?site=${id2}`);
  await expect(light).toContainText('A very dim day');
  await expect(light).not.toContainText('looks fine');
  await expect(light).not.toContainText('possible cause');
});

test('traffic light: a steady but low plant is never called fine; the light names the cause', async ({ page, request }) => {
  const id = await createSite(request);
  // The same synthetic weather at about 70% of the estimate from day one: steady, so nothing is ever flagged
  // against the plant's own baseline, while the audit ranks "low since the start" high and suggests an inspection.
  // 22 rows: the last one (26 Aug) is a judged day; the 21st (25 Aug) is too dim to judge and would show as such.
  await postRows(request, id, syntheticRows().slice(0, 22).map((r) => ({ ...r, kwh: (Number(r.kwh) * 0.70 / 0.92).toFixed(1) })));
  await page.goto(`/?site=${id}`);
  const light = page.getByTestId('light');
  await expect(light).toContainText('Near usual, but the audit points to a possible cause.');
  await expect(light).toContainText('A possible cause: Low since the start (high confidence). A possible cause, not a diagnosis.');
  await expect(light).not.toContainText('looks fine');
  await expect(light.locator('.light')).toHaveClass(/cause/);
  expect(await light.locator('.light-icon path').count()).toBe(1);  // the half-covered sun: a third shape
  await expect(page.getByTestId('headline')).toContainText('Top possible cause: Low since the start');
});

test('voice input: a spoken number keeps Indian thousands grouping and the status reads back the stored value', async ({ page, request }) => {
  const id = await createSite(request);
  await page.addInitScript(() => {
    // A stand-in recognizer: the real one in Chrome sends audio to Google and cannot run headless.
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() { setTimeout(() => this.onresult({ results: [[{ transcript: 'about 12,345.5 units' }]] }), 0); }
      stop() {}
    };
  });
  await page.goto(`/?site=${id}#log`);
  await page.getByRole('button', { name: 'Say the number' }).click();
  await expect(page.getByLabel('Energy produced (kWh)', { exact: true })).toHaveValue('12345.5');
  await expect(page.locator('#status')).toHaveText('12345.5 kWh');
});

test('setup wizard: three steps, big choices, tilt from latitude, same API call', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Where is the plant?')).toBeVisible();
  await expect(page.locator('#wiz-2')).toBeHidden();
  // Required fields are checked before moving on.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#wiz-1')).toBeVisible();
  await page.getByLabel('Latitude').fill('26.85');
  await page.getByLabel('Longitude').fill('80.95');
  await page.getByLabel('Longitude').press('Enter');  // Enter in a field goes to the next step, never a hidden submit
  await expect(page.getByText('Tell us about the panels')).toBeVisible();
  await expect(page.getByLabel('Panel tilt (degrees)')).toHaveValue('27');  // pre-filled from the latitude
  await expect(page.getByRole('radio', { name: 'South', exact: true })).toBeChecked();
  await expect(page.getByRole('radio')).toHaveCount(8);  // every direction the API supports
  // The pre-filled tilt follows a changed latitude; a tilt the owner typed stays.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByLabel('Latitude').fill('12.97');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Panel tilt (degrees)')).toHaveValue('13');
  await page.getByLabel('Panel tilt (degrees)').fill('27');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Panel tilt (degrees)')).toHaveValue('27');
  await page.getByLabel('Plant size (kW)').fill('3');
  await page.getByRole('radio', { name: 'South-west' }).check();
  await expect(page.locator('.big-choice label.checked')).toHaveText('South-west');  // visible without :has() too
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Do you know the system loss?')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Plant size (kW)')).toHaveValue('3');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Start auditing' }).click();
  await expect(page.getByTestId('light')).toContainText('No readings yet');
  await expect(page.locator('#plant-summary')).toContainText('tilt 27° · facing south-west');
  await expect(page.getByText('Sample values in use')).toBeVisible();
});

test('accessibility basics: 48px targets, bigger text, photo-first log, mic and read-aloud only when supported', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}#log`);
  // The camera control is the largest control on the Log tab.
  const cam = await page.locator('#photo-pick').boundingBox();
  const save = await page.getByRole('button', { name: 'Save reading' }).boundingBox();
  expect(cam.height).toBeGreaterThanOrEqual(96);
  expect(cam.height).toBeGreaterThan(save.height);
  // No capture attribute: the phone's picker offers the gallery too, so a saved inverter-app screenshot can be chosen.
  expect(await page.locator('#photo').getAttribute('capture')).toBeNull();
  expect(await page.locator('#photo').getAttribute('accept')).toContain('image');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Surya Audit');
  // Every visible button, link-button, expander and tab on every tab is at least 48px tall (the README's claim).
  for (const name of TAB_NAMES) {
    await page.getByRole('tab', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('button, a.button, a.link, summary, [role=tab]'))
      .filter((n) => n.offsetParent !== null && !n.closest('[hidden]'))
      .map((n) => [n.textContent.trim().slice(0, 20), Math.round(n.getBoundingClientRect().height)])
      .filter(([, h]) => h < 48));
    expect(small, name).toEqual([]);
  }
  await page.getByRole('tab', { name: 'Log', exact: true }).focus();
  await page.keyboard.press('Enter');
  // Bigger text is a toggle that persists.
  const before = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  await page.getByRole('button', { name: 'Bigger text' }).click();
  const after = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  expect(after).toBeGreaterThan(before);
  await page.reload();
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))).toBe(after);
  await page.getByRole('button', { name: 'Bigger text' }).click();
  // Speech features appear only where the browser supports them, with the privacy note.
  const hasRec = await page.evaluate(() => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  await expect(page.locator('#mic')).toBeVisible({ visible: hasRec });
  await expect(page.locator('#mic-note')).toBeVisible({ visible: hasRec });
  if (hasRec) await expect(page.locator('#mic-note')).toContainText('goes to Google');
  const hasVoice = await page.evaluate(() => 'speechSynthesis' in window && speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith('en')));
  await page.getByRole('tab', { name: 'Today', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('light').getByRole('button', { name: 'Read aloud' })).toBeVisible({ visible: hasVoice });
  await expectNoSideScroll(page);
});
