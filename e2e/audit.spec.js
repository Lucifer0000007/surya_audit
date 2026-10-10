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

// The reading date: Today and Yesterday are chips; any other date comes from the field "Other date" shows.
async function setReadingDate(page, iso) {
  await page.getByText('Other date', { exact: true }).click();
  await page.getByLabel('Date', { exact: true }).fill(iso);
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
  await setReadingDate(page, '2026-09-01');
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
  await expect(page.getByText('Surya Audit does not keep your photo; Google Gemini reads it under Google’s own terms.')).toBeVisible();
  await page.locator('#photo').setInputFiles({ name: 'meter.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
  await expect(page.locator('#photo-note')).toContainText('type the reading by hand');
  await expect(page.locator('#photo-note')).toContainText('The photo was not saved.');

  // Nothing was saved by the photo; typing still works.
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar')).toHaveCount(0);
  await openTab(page, 'Log');
  await setReadingDate(page, '2026-09-02');
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
  expect(await animationOf(page.locator('#panel-why > .band'))).toBe('none');
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
  await expect(impact).toContainText('Output shortfall in the dips');
  await expect(impact).toContainText('flagged as dips');
  await expect(impact).toContainText('at Rs 7 per unit (assumption)');
  // The CO2 line says what the shortfall would have displaced, at the factor in use, labelled an assumption.
  await expect(impact).toContainText('it would have displaced about');
  await expect(impact).toContainText('kg of avoided grid CO₂ at 0.675 kg per unit (assumption).');
  for (const word of [/litre/i, /emissions saved/i, /CO₂ lost/i, /lost CO/i]) await expect(impact).not.toContainText(word);
  // Dust is suspected but no day has crossed the dip line yet: the clean's cost is shown, no payback invented.
  await expect(impact).toContainText('0 flagged as dips');
  await expect(impact).toContainText('A clean costs about');
  await expect(impact).toContainText('no daily loss to set against it');
  await expect(impact).toContainText('not a promise');
  await expect(impact).not.toContainText('n/a');
  await expect(impact).toContainText('Cleanings avoided: 1 a month. A fixed schedule of 2 a month (assumption) against 1 that the audit suggests now.');
  // Every default is labelled an assumption and has a source link with a retrieval date.
  await impact.getByText('How we calculated this').click();
  await expect(impact.locator('label .tag')).toHaveCount(6);
  await expect(impact).toContainText('each with the date it was retrieved');
  await expect(impact.locator('#assume-sources li')).toHaveCount(4);
  await expect(impact.locator('#assume-sources li').nth(0)).toContainText('Retrieved 2026-10-08.');
  await expect(impact.locator('#assume-sources li').nth(1)).toContainText('version 22.0 (workbook dated 2026-08-01)');
  await expect(impact.locator('#assume-sources li').nth(1)).toContainText('Retrieved 2026-10-10.');
  await expect(impact.locator('#assume-sources a')).toHaveCount(7);  // every quoted figure links to its document
  // The factor's origin is an editable label, not buried: CEA database version and factor type, with defaults.
  await expect(impact.getByLabel('CEA CO₂ Baseline Database version')).toHaveValue('22.0');
  await expect(impact.getByLabel('Factor type (margin type)')).toHaveValue('weighted average, including imports, FY 2025-26');
  await expect(impact).not.toContainText('Water per panel');
  await expect(impact).not.toContainText('Panels on the roof');
  // After the fault: 5 flagged dips carry a real loss; dust is no longer supported, so no payback line.
  await postRows(request, id, rows.slice(42));
  await page.reload();
  await expect(page.getByTestId('impact')).toBeVisible();
  await expect(page.getByTestId('impact')).toContainText('5 flagged as dips');
  await expect(page.getByTestId('impact')).not.toContainText('pays back');
  await expect(page.getByTestId('impact')).toContainText('Cleanings avoided: 2 a month. A fixed schedule of 2 a month (assumption) against 0 that the audit suggests now.');
  // Editing the tariff doubles the rupee figure; reset restores the default.
  const money = () => page.getByTestId('impact').locator('.stat').nth(1).locator('.value').textContent();
  const before = Number((await money()).replace(/[^0-9]/g, ''));
  expect(before).toBeGreaterThan(0);
  await page.getByTestId('impact').getByText('How we calculated this').click();
  await page.getByTestId('impact').getByLabel(/Tariff, Rs per unit/).fill('14');
  await page.getByRole('button', { name: 'Use these values' }).click();
  await expect(page.getByTestId('impact')).toContainText('at Rs 14 per unit (assumption)');
  const after = Number((await money()).replace(/[^0-9]/g, ''));
  expect(Math.abs(after - 2 * before)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(page.getByTestId('impact')).toContainText('at Rs 14 per unit');  // remembered on this device
  await page.getByTestId('impact').getByText('How we calculated this').click();
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByTestId('impact')).toContainText('at Rs 7 per unit');

  // An empty emission factor means no CO2 figure at all, said plainly; the shortfall in kWh stays.
  await page.getByTestId('impact').getByLabel(/Emission factor, kg CO₂ per unit/).fill('');
  await page.getByRole('button', { name: 'Use these values' }).click();
  await expect(page.locator('#co2-line')).toHaveText('No CO₂ figure: no emission factor is set. Add one under “How we calculated this”.');
  await expect(page.getByTestId('impact').locator('.stat').nth(0).locator('.value')).not.toHaveText('0 kWh');
  await page.reload();
  await expect(page.locator('#co2-line')).toContainText('No CO₂ figure');  // an empty factor is remembered as empty, not as zero
  await page.getByTestId('impact').locator('summary').click();
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.locator('#co2-line')).toContainText('avoided grid CO₂ at 0.675 kg per unit (assumption)');

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
  await setReadingDate(page, '2026-08-20');
  await page.getByLabel('Energy produced (kWh)').fill('9.9');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#queue')).toContainText('Offline: 1 reading will be saved when you are connected');
  await expect(page.locator('#status')).toContainText('will be saved when you are connected');
  // Queued items keep the overwrite confirmation.
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('waiting to be saved'); dialog.accept(); });
  await setReadingDate(page, '2026-08-20');
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

test('offline: the Try now button sends a waiting reading', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}#log`);
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));  // the call fails with no answer, as offline does
  await setReadingDate(page, '2026-08-21');
  await page.getByLabel('Energy produced (kWh)').fill('8.8');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#queue')).toContainText('1 reading');
  await page.unroute('**/readings');
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.locator('#status')).toContainText('Saved the waiting reading.');
  await expect(page.locator('#queue')).toBeHidden();
  expect((await (await request.get(`/api/sites/${id}/audit`)).json()).timeline).toHaveLength(3);
});

test('languages: Hindi and Punjabi interface, units not kWh, fonts inline, honesty text translated, no overflow', async ({ page, request, baseURL }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);
  // The fonts are carried by the page: no request leaves for them.
  const outside = [];
  page.on('request', (req) => { if (!req.url().startsWith(baseURL)) outside.push(req.url()); });

  await page.evaluate(() => say('Saved the reading.'));
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.locator('#status')).toHaveText('');  // a status written in English does not linger on a Hindi page
  await expect(page.getByRole('tab', { name: 'आज', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('headline')).toContainText('3 अक्तू॰ 2026');  // months come from the translations, not the browser
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
  // The suggestion's own sentence is translated too, with nothing left marked as English.
  await page.getByRole('tab', { name: 'ਹੱਲ', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('action-check_inverter')).toContainText('ਇਨਵਰਟਰ ਜਾਂਚੋ');
  await expect(page.getByTestId('action-check_inverter')).toContainText('ਇਨਵਰਟਰ ਦੀ ਸਕ੍ਰੀਨ ਜਾਂ ਐਪ ਵਿੱਚ ਐਰਰ ਕੋਡ ਵੇਖੋ');
  await expect(page.getByTestId('action-check_inverter').locator('[lang="en"]')).toHaveCount(0);
  await expect(page.getByTestId('action-check_inverter').getByRole('button', { name: 'ਮਨਜ਼ੂਰ' })).toBeVisible();
  // The Report tab's own callouts and status are translated; the draft itself stays English.
  await page.getByRole('tab', { name: 'ਸ਼ਿਕਾਇਤ', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'ਸ਼ਿਕਾਇਤ ਦਾ ਖਰੜਾ ਬਣਾਓ' }).click();
  await expect(page.locator('#draft-out')).toContainText('ਕੁਝ ਭੇਜਿਆ ਨਹੀਂ ਗਿਆ।');
  await expect(page.locator('#status')).toHaveText('ਖਰੜਾ ਤਿਆਰ। ਕੁਝ ਭੇਜਿਆ ਨਹੀਂ ਗਿਆ।');
  await expect(page.locator('#draft-text')).toHaveValue(/OWNER TO FILL/);
  await expect(page.getByText('ਸ਼ਿਕਾਇਤ ਦਾ ਖਰੜਾ (ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ)')).toBeVisible();  // the draft is labelled as English
  expect(await page.locator('#categories').getAttribute('lang')).toBeNull();  // its lead and note are Punjabi; only the category names are English
  await expect(page.locator('#categories span[lang="en"]')).toHaveCount(1);
  await expect(page.locator('#categories')).toContainText('ਨਮੂਨਾ (SAMPLE)');

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
  await page.getByText('South-west', { exact: true }).click();  // the label, as an owner does (the radio itself is hidden)
  await expect(page.getByRole('radio', { name: 'South-west' })).toBeChecked();
  await expect(page.locator('#wiz-2 .big-choice label.checked')).toHaveText('South-west');  // visible without :has() too
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

// ---------- phase 9: UI polish ----------

test('flags: one strip above the tabs names each flag; the explanations sit behind it with their wording unchanged', async ({ page, request }) => {
  const id = await createSite(request);  // synthetic, no loss given: both flags apply
  await postRows(request, id, syntheticRows().slice(0, 3));
  await page.goto(`/?site=${id}`);
  const strip = page.getByTestId('flags');
  await expect(strip.locator('summary')).toContainText('Synthetic data');
  await expect(strip.locator('summary')).toContainText('Sample values in use');
  await expect(strip.locator('.flag.synthetic')).toBeVisible();  // the synthetic flag keeps its amber warning style
  expect((await strip.locator('summary').boundingBox()).height).toBeGreaterThanOrEqual(48);
  // Collapsed: the explanations are not shown, and the flags themselves are.
  await expect(strip).not.toHaveAttribute('open', '');
  await expect(strip.getByText('They do not describe a real plant.')).toBeHidden();
  await strip.locator('summary').click();
  await expect(strip.getByText('This plant and its readings are made up for a demo. They do not describe a real plant.')).toBeVisible();
  await expect(strip.getByText('No system loss was given, so a SAMPLE value of 14% is assumed. It is a placeholder, not a measurement.')).toBeVisible();
  // Above the tabs on every tab, and the open state survives a re-render.
  for (const name of TAB_NAMES) {
    await openTab(page, name);
    expect(await page.evaluate(() => Boolean(document.getElementById('banners').compareDocumentPosition(document.getElementById('tablist')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(strip.locator('summary')).toBeVisible();
  }
  await expect(strip).toHaveAttribute('open', '');
  // A plant that is neither synthetic nor sample shows no strip at all.
  const real = await request.post('/api/sites', { data: { lat: 26.85, lon: 80.95, kw: 3, tilt: 20, azimuth: 180, loss_pct: 14 } });
  await page.goto(`/?site=${(await real.json()).id}`);
  await expect(page.getByTestId('flags')).toHaveCount(0);
});

test('Log: Save stays aria-disabled until there is a value; tapping it goes to the field and the hint says why', async ({ page, request }) => {
  const id = await createSite(request);
  const posted = [];
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/readings')) posted.push(req.url()); });
  await page.goto(`/?site=${id}#log`);
  const save = page.getByRole('button', { name: 'Save reading' });
  const kwhField = page.getByLabel('Energy produced (kWh)', { exact: true });
  await expect(save).toBeVisible();  // the page has finished loading
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  expect(await save.getAttribute('disabled')).toBeNull();  // aria-disabled, never the disabled attribute
  await expect(save).toHaveAttribute('aria-describedby', 'save-hint');
  await expect(page.locator('#save-hint')).toBeVisible();
  await save.dispatchEvent('click');  // Playwright treats aria-disabled as not actionable; a real tap goes through
  await expect(kwhField).toBeFocused();
  await kwhField.press('Enter');  // Enter in the empty field does not save either
  expect(posted).toEqual([]);
  await kwhField.fill('12.4');
  await expect(save).toHaveAttribute('aria-disabled', 'false');
  await expect(page.locator('#save-hint')).toBeHidden();
  expect(await save.getAttribute('aria-describedby')).toBeNull();
  await kwhField.fill('-3');  // not a valid reading
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await kwhField.fill('');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  // The only solid primary on the Log tab is Save; the photo zone is outlined.
  const zone = await page.locator('#photo-pick').evaluate((n) => { const s = getComputedStyle(n); return { bg: s.backgroundColor, border: s.borderTopStyle }; });
  expect(zone.border).toBe('dashed');
  expect(zone.bg).toBe('rgba(0, 0, 0, 0)');
  await kwhField.fill('12.4');
  const primary = await save.evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(primary).not.toBe('rgba(0, 0, 0, 0)');
});

test('Log: the kWh field has a placeholder, a decimal keyboard, no spinners and a units label', async ({ page, request }) => {
  const id = await createSite(request);
  await page.goto(`/?site=${id}#log`);
  const field = page.getByLabel('Energy produced (kWh)', { exact: true });
  await expect(field).toHaveAttribute('placeholder', 'e.g. 12.4…');
  await expect(field).toHaveAttribute('inputmode', 'decimal');
  await expect(field).toHaveCSS('appearance', 'textfield');  // no spinner buttons
  await expect(page.locator('#reading-form')).toHaveAttribute('autocomplete', 'off');
  await expect(page.locator('.with-mic .unit')).toHaveText('units');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('.with-mic .unit')).toHaveText('यूनिट');
  await expect(page.locator('#kwh-input')).toHaveAttribute('placeholder', 'जैसे 12.4…');
});

test('Log: Today and Yesterday chips, Other date, and the overwrite confirmation', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}#log`);
  const today = await page.evaluate(() => isoDaysAgo(0));
  const yesterday = await page.evaluate(() => isoDaysAgo(1));
  const dateValue = () => page.evaluate(() => document.querySelector('#reading-form [name=date]').value);
  await expect(page.getByRole('radio', { name: 'Today' })).toBeChecked();
  expect(await dateValue()).toBe(today);
  // Each chip carries its date, so "Yesterday" can never be mistaken for another day.
  await expect(page.locator('.chips label').nth(0)).toContainText(await page.evaluate(() => fmtDate(isoDaysAgo(0), true)));
  await expect(page.locator('.chips label').nth(1)).toContainText(await page.evaluate(() => fmtDate(isoDaysAgo(1), true)));
  await expect(page.locator('#date-other')).toBeHidden();
  await page.getByText('Yesterday', { exact: true }).click();
  expect(await dateValue()).toBe(yesterday);
  await page.getByText('Other date', { exact: true }).click();
  await expect(page.locator('#date-other')).toBeVisible();
  await page.getByLabel('Date', { exact: true }).fill('2026-08-20');
  await expect(page.locator('#date-shown')).toHaveText('Reading for 20 Aug 2026');
  await page.getByLabel('Energy produced (kWh)', { exact: true }).fill('9.9');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading for 20 Aug 2026');
  // The same date again asks before it replaces.
  let asked = '';
  page.once('dialog', (dialog) => { asked = dialog.message(); dialog.accept(); });
  await page.getByLabel('Energy produced (kWh)', { exact: true }).fill('10.5');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading for 20 Aug 2026');
  expect(asked).toContain('already saved');
  // A date read from a photo picks the chip that matches it; any other date opens Other date.
  await page.evaluate((d) => setReadingDate(d), today);
  await expect(page.getByRole('radio', { name: 'Today' })).toBeChecked();
  await page.evaluate((d) => setReadingDate(d), yesterday);
  await expect(page.getByRole('radio', { name: 'Yesterday' })).toBeChecked();
  await page.evaluate(() => setReadingDate('2026-09-09'));
  await expect(page.getByRole('radio', { name: 'Other date' })).toBeChecked();
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-09-09');
});

test('Log: the drop zone takes a dropped screenshot', async ({ page, request }) => {
  const id = await createSite(request);
  await page.goto(`/?site=${id}#log`);
  const data = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    return dt;
  }, TINY_PNG);
  const zone = page.locator('#photo-pick');
  await zone.dispatchEvent('dragover', { dataTransfer: data });
  await expect(zone).toHaveClass(/over/);
  await zone.dispatchEvent('drop', { dataTransfer: data });
  await expect(zone).not.toHaveClass(/over/);
  await expect(page.locator('#photo-review')).toBeVisible();
  await expect(page.locator('#photo-note')).toContainText('type the reading by hand');  // no key offline: the same fallback as a picked photo
});

test('first visit follows the browser language when it is Hindi or Punjabi; a choice made later wins and is the only one remembered', async ({ browser, baseURL, request }) => {
  const id = await createSite(request);
  for (const [locale, expected] of [['hi-IN', 'hi'], ['pa-IN', 'pa'], ['fr-FR', 'en']]) {
    const context = await browser.newContext({ locale, baseURL });
    const page = await context.newPage();
    await page.goto(`/?site=${id}`);
    await expect(page.locator('html')).toHaveAttribute('lang', expected);
    expect(await page.evaluate(() => localStorage.getItem('surya-audit-lang'))).toBeNull();  // a default is not a choice
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await page.evaluate(() => localStorage.getItem('surya-audit-lang'))).toBe('en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await context.close();
  }
});

test('type and layout: nothing under 14px, help text 15px and scaled by Bigger text, A+ has a tooltip, a skip link, theme colours', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  const small = () => page.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll('body *')) {
      if (n.closest('[hidden], script, style') || !n.getClientRects().length) continue;
      if (!Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
      const px = parseFloat(getComputedStyle(n).fontSize);
      const mono = /monospace|Menlo|Consolas/i.test(getComputedStyle(n).fontFamily);  // metadata only; Hindi and Punjabi never use it
      if (px < (mono ? 13 : 14)) out.push(`${px}px ${n.tagName} "${n.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  for (const lng of ['en', 'hi', 'pa']) {
    await page.goto('/');
    await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lng);
    for (const tab of ['today', 'log', 'fix', 'why', 'report']) {
      await page.goto(`/?site=${id}#${tab}`);
      await expect(page.locator(`#panel-${tab}`)).toBeVisible();
      if (tab === 'why') await page.locator('#chart svg').waitFor();
      expect(await small(), `${lng}/${tab}`).toEqual([]);
    }
  }
  // Help text is 15px, and Bigger text scales it with everything else (rem units follow the root size).
  await page.goto('/');  // a full load: the language is read from storage when the page starts
  await page.evaluate(() => localStorage.setItem('surya-audit-lang', 'en'));
  await page.goto(`/?site=${id}#log`);
  const help = () => page.locator('#log .note').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  expect(await help()).toBe(15);
  await page.getByRole('button', { name: 'Bigger text' }).click();
  expect(await help()).toBeGreaterThan(17);
  await page.getByRole('button', { name: 'Bigger text' }).click();
  // A+ has an aria-label and a tooltip, in every language.
  const bigger = page.locator('#bigger');
  await expect(bigger).toHaveAttribute('aria-label', 'A+ Bigger text');  // starts with the visible text
  await expect(bigger).toHaveAttribute('title', 'Bigger text');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(bigger).toHaveAttribute('title', 'बड़े अक्षर');
  await expect(bigger).toHaveAttribute('aria-label', 'A+ बड़े अक्षर');
  // The skip link is the first stop and moves focus to the content.
  await page.getByRole('button', { name: 'English' }).click();
  await page.reload();
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  expect((await page.locator('.skip').boundingBox()).y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  // Light and dark theme colours, brand names left alone by translators, thumbnail size, no autocomplete on forms.
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  expect(await page.locator('meta[name="theme-color"][media*="dark"]').getAttribute('content')).toBe('#0a0a0a');
  expect(await page.locator('.brand span').getAttribute('translate')).toBe('no');
  expect(await page.locator('#draft-text').getAttribute('translate')).toBe('no');
  expect(await page.locator('#photo-thumb').getAttribute('width')).toBe('72');
  for (const f of ['#setup-form', '#reading-form', '#assume-form']) expect(await page.locator(f).getAttribute('autocomplete')).toBe('off');
});

test('desktop backdrop: from 1100px the column sits on a darker backdrop; phones and tablets keep a plain page', async ({ page, request }) => {
  const id = await createSite(request);
  await page.goto(`/?site=${id}`);
  for (const [width, backdrop] of [[1280, true], [1099, false], [393, false]]) {
    await page.setViewportSize({ width, height: 800 });
    const image = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    expect(image.includes('linear-gradient'), `${width}px`).toBe(backdrop);
  }
});

test('no English left in Hindi and Punjabi: known audit sentences are translated, anything else is marked lang="en" and counted', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the language check does not depend on the viewport');
  test.setTimeout(240_000);
  const rows = syntheticRows();
  const scale = (rs, f) => rs.map((r, i) => ({ ...r, kwh: (Number(r.kwh) * f(i)).toFixed(1) }));
  const LOW = 0.70 / 0.92;
  const approve = async (id, kind, on) => {
    const audit = await (await request.get(`/api/sites/${id}/audit`)).json();
    const act = audit.actions.find((a) => a.kind === kind && a.status === 'proposed');
    expect(act, `a proposed ${kind} to approve`).toBeTruthy();
    expect((await request.post(`/api/sites/${id}/actions/${act.id}/approve`, { data: { approved_on: on } })).ok()).toBeTruthy();
  };
  const later = (n) => ({ date: `2026-10-0${3 + n}`, kwh: '5.0', kind: 'daily' });  // after the recorded weather: not published yet
  const stages = [];  // [site id, stage name]: each is scanned in Hindi and Punjabi on Fix, Why and Report
  const snap = (id, name) => stages.push([id, name]);

  // A new plant: too few readings to judge, then a usual level not learnt yet, then a healthy plant.
  let id = await createSite(request);
  await postRows(request, id, rows.slice(0, 2)); snap(id, 'two readings');
  await postRows(request, id, rows.slice(2, 5)); snap(id, 'five readings');
  await postRows(request, id, rows.slice(5, 20)); snap(id, 'healthy');
  // The synthetic fault, then the suggestion approved with readings whose weather is not published yet.
  await postRows(request, id, rows.slice(20)); snap(id, 'fault');
  await approve(id, 'check_inverter', rows[rows.length - 1].date);
  await postRows(request, id, [later(1)]); snap(id, 'verification pending');
  await postRows(request, id, [later(2), later(3)]); snap(id, 'verdict provisional, waiting for weather');
  // A plant low since day one, an inspection approved, readings still low: the complaint is suggested.
  id = await createSite(request);
  await postRows(request, id, scale(rows.slice(0, 21), () => LOW)); snap(id, 'low since the start');
  await approve(id, 'request_inspection', rows[20].date);
  await postRows(request, id, scale(rows.slice(21, 24), () => LOW)); snap(id, 'inspection did not help');
  // Low at first, then back to normal.
  id = await createSite(request);
  await postRows(request, id, scale(rows.slice(0, 14), () => LOW));
  await postRows(request, id, rows.slice(14, 30)); snap(id, 'low then normal');
  // A slow slide, a clean, and output back; and a clean that did not help.
  const slide = (i) => (i < 12 ? 1 : Math.max(0.45, 1 - 0.02 * (i - 11)));
  id = await createSite(request);
  await postRows(request, id, scale(rows.slice(0, 30), slide)); snap(id, 'dust');
  await approve(id, 'clean_panels', rows[29].date);
  await postRows(request, id, rows.slice(30, 34)); snap(id, 'clean worked');
  id = await createSite(request);
  await postRows(request, id, scale(rows.slice(0, 30), slide));
  await approve(id, 'clean_panels', rows[29].date);
  await postRows(request, id, scale(rows.slice(30, 36), () => 0.5)); snap(id, 'clean did not help');

  const found = { translated: 0, english: new Set(), unknown: new Set(), leftovers: new Set() };
  let scans = 0;
  const scan = async (lng, siteId, tab, label) => {
    await page.goto(`/?site=${siteId}&scan=${++scans}#${tab}`);  // a new URL each time: always a fresh load of the plant
    await expect(page.locator(`#panel-${tab}`)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', lng);  // the language state first: under lang="en" the scan below would skip every node and pass empty
    if (tab === 'report') { await page.locator('#draft-btn').click(); await expect(page.locator('#draft-out')).toBeVisible(); }
    const result = await page.evaluate(() => {
      document.querySelectorAll('details').forEach((d) => { d.open = true; });
      const shown = (n) => n.getClientRects().length > 0 && !n.closest('[hidden]');
      const keep = /^(Surya|Audit|SAMPLE|synthetic|SYNTHETIC|WhatsApp|JSON|PVGIS|NASA|POWER|MNRE|JRC|CEA|EU|Google|Gemini|Chrome|AWS|DynamoDB|Lambda|API|Gateway|HTTP|FastAPI|EventBridge|Scheduler|Parameter|Store|SecureString|IAM|CloudWatch|Logs|kW|kWh|kg|CO|OWNER|TO|FILL|lifetime|latitude|longitude|EN|English|CSV|YYYY|MM|DD)$/;  // brand and source names, units, format names and labels kept verbatim
      const latin = (s) => (s.match(/[A-Za-z]{2,}/g) || []).filter((w) => !keep.test(w));
      const srv = Array.from(document.querySelectorAll('[data-srv]')).filter(shown).map((n) => [n.dataset.srv, n.textContent.trim()]);
      const left = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement;
        if (!p || !shown(p) || p.closest('[lang="en"], script, style, svg, textarea, #status, .tip')) continue;
        const words = latin(n.textContent);
        if (words.length) left.push(`${words.join(' ')} :: ${n.textContent.trim().slice(0, 60)}`);
      }
      for (const n of document.querySelectorAll('[aria-label], [title], [placeholder], img[alt]')) {
        if (!shown(n) || n.closest('[lang="en"]')) continue;
        for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
          const v = n.getAttribute(a);
          if (v && latin(v).length) left.push(`${a}="${v}"`);
        }
      }
      return { srv, left };
    });
    for (const [kind, text] of result.srv) {
      if (kind === 'translated') { found.translated += 1; expect(text, 'a translation with a hole').not.toMatch(/undefined|NaN|\{\d\}/); }
      else if (kind === 'english') found.english.add(text);
      else found.unknown.add(text);
    }
    for (const l of result.left) found.leftovers.add(`${lng}/${tab}/${label}: ${l}`);
  };
  for (const lng of ['hi', 'pa']) {
    await page.goto('/');
    await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lng);
    for (const tab of ['today', 'log']) await scan(lng, stages[stages.length - 1][0], tab, 'chrome');
    for (const [siteId, name] of stages) for (const tab of ['fix', 'why', 'report']) await scan(lng, siteId, tab, name);
  }
  testInfo.annotations.push({ type: 'english-fallback', description: `${found.english.size} distinct server sentence(s) shown in English with lang="en"` });
  await testInfo.attach('english-fallbacks.json', { body: JSON.stringify([...found.english], null, 2), contentType: 'application/json' });
  console.log(`translated server sentences shown: ${found.translated}; distinct English fallbacks: ${found.english.size}`);
  expect(found.translated, 'the scenarios reached the translated sentences').toBeGreaterThan(40);
  expect([...found.unknown], 'a sentence the table knows but has no translation for').toEqual([]);
  expect([...found.leftovers], 'English left on a Hindi or Punjabi page').toEqual([]);
});

test('a photo note and an error do not linger in the old language after a switch; a failed load keeps its message', async ({ page, request }) => {
  const id = await createSite(request);
  await page.goto(`/?site=${id}#log`);
  await page.locator('#photo').setInputFiles({ name: 'meter.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
  await expect(page.locator('#photo-note')).toContainText('type the reading by hand');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('#photo-note')).toHaveText('');
  await expect(page.locator('#photo-review')).toBeVisible();  // the photo itself stays for the owner to discard

  // An error from saving a reading is cleared by the switch...
  await page.getByRole('button', { name: 'English' }).click();
  await page.route('**/api/sites/*/readings', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'reading date is in the future' }) }));
  await page.getByLabel('Energy produced (kWh)', { exact: true }).fill('9.5');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#error')).toBeVisible();
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('#error')).toBeHidden();

  // ...but a plant that failed to load keeps its message next to Try again.
  await page.unroute('**/api/sites/*/readings');
  await page.route('**/api/sites/*/audit', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.goto(`/?site=${id}&failing=1#today`);
  await expect(page.locator('#retry')).toBeVisible({ timeout: 15000 });  // the read is tried 3 times, 1 s and 3 s apart
  await expect(page.locator('#error')).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('#retry')).toBeVisible();
  await expect(page.locator('#error')).toBeVisible();
});

test('the complaint line about categories follows a language switch, in both directions', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}#report`);
  await page.locator('#draft-btn').click();
  await expect(page.locator('#categories')).toContainText('SAMPLE: category names are unverified.');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('#categories')).toContainText('नमूना (SAMPLE)');  // the warning is not left in English
  await expect(page.locator('#categories')).not.toContainText('unverified');
  expect(await page.locator('#categories').getAttribute('lang')).toBeNull();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('#categories')).toContainText('SAMPLE: category names are unverified.');
  await expect(page.locator('#categories')).not.toContainText('नमूना');
});

test('Today and Yesterday follow midnight in a tab that was left open', async ({ page, request }) => {
  const id = await createSite(request);
  await page.clock.install({ time: new Date('2026-10-10T23:50:00') });
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#date-shown')).toHaveText('Reading for 10 Oct 2026');
  await page.clock.setFixedTime(new Date('2026-10-11T00:10:00'));  // the tab is still open after midnight
  await page.getByLabel('Energy produced (kWh)', { exact: true }).fill('9.5');
  const posted = page.waitForRequest((req) => req.method() === 'POST' && req.url().includes('/readings'));
  await page.getByRole('button', { name: 'Save reading' }).click();
  expect((await posted).postDataJSON().date).toBe('2026-10-11');  // the new day, not the stale 10 Oct
});

test('motion: the headline number counts up and the arc eases, the tab indicator slides, a recovery is celebrated with confetti', async ({ page, request }) => {
  await page.addInitScript(() => {  // every value the headline number takes, in order
    window.__ring = [];
    new MutationObserver(() => {
      const n = document.querySelector('#headline .ring-num');
      if (n && n.textContent && window.__ring[window.__ring.length - 1] !== n.textContent) window.__ring.push(n.textContent);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring-num')).toHaveText(/^\d+%$/);
  await expect.poll(() => page.evaluate(() => window.__ring.length), 'the number passes through values on its way up').toBeGreaterThan(2);
  expect(await page.locator('#headline .gauge-arc').evaluate((n) => getComputedStyle(n).transitionDuration)).toBe('0.9s');
  // The tab indicator is one element that moves under the selected tab.
  await expect(page.locator('.tab-indicator')).toHaveCount(1);
  expect(await page.locator('#tablist').evaluate((n) => n.style.getPropertyValue('--i'))).toBe('0');
  await openTab(page, 'Why');
  expect(await page.locator('#tablist').evaluate((n) => n.style.getPropertyValue('--i'))).toBe('3');
  // Confetti is 28 pieces that remove themselves.
  await page.evaluate(() => confetti(document.getElementById('headline')));
  await expect(page.locator('.confetti i')).toHaveCount(28);
  await expect(page.locator('.confetti')).toHaveCount(0, { timeout: 4000 });
});

test('motion: reduced motion draws no confetti and the skeleton does not shimmer', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring-num')).toHaveText(/^\d+%$/);
  await page.evaluate(() => confetti(document.getElementById('headline')));
  await expect(page.locator('.confetti')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sk-card'), '::after').animationName)).toBe('none');
});

test('impact: the CO2 figure is the shortfall times the factor, follows an edited factor, and an edited factor drops the CEA labels', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}`);
  const impact = page.getByTestId('impact');
  await expect(impact).toBeVisible();
  const shortfall = async () => Number((await impact.locator('.stat').nth(0).locator('.value').innerText()).replace(/[^0-9.]/g, ''));
  const y = async () => Number((await page.locator('#co2-line').innerText()).match(/about ([0-9.,]+) kg/)[1].replace(/,/g, ''));
  const lost = await shortfall();
  expect(lost).toBeGreaterThan(5);
  expect(Math.abs((await y()) - lost * 0.675)).toBeLessThanOrEqual(0.2);
  await impact.getByText('How we calculated this').click();
  await impact.getByLabel(/Emission factor, kg CO₂ per unit/).fill('0.9');
  await page.getByRole('button', { name: 'Use these values' }).click();
  expect(Math.abs((await y()) - lost * 0.9)).toBeLessThanOrEqual(0.2);
  // The factor is the owner's now: it no longer sits under the CEA version and type it was sourced with.
  await expect(impact.getByLabel('CEA CO₂ Baseline Database version')).toHaveValue('');
  await expect(impact.getByLabel('Factor type (margin type)')).toHaveValue('');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(impact.getByLabel('CEA CO₂ Baseline Database version')).toHaveValue('22.0');
  // A plant with no dips and an emptied factor: no CO2 figure, the kWh stat stays.
  const calm = await createSite(request);
  await postRows(request, calm, syntheticRows().slice(0, 20));
  await page.goto(`/?site=${calm}&calm=1`);
  await page.getByTestId('impact').getByText('How we calculated this').click();
  await page.getByTestId('impact').getByLabel(/Emission factor, kg CO₂ per unit/).fill('');
  await page.getByRole('button', { name: 'Use these values' }).click();
  await expect(page.locator('#co2-line')).toContainText('No CO₂ figure');
  await expect(page.getByTestId('impact').locator('.stat').nth(0).locator('.value')).toContainText('kWh');
});

test('impact: stored assumptions that are not usable fall back to the sourced defaults and never break the page', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  for (const bad of ['5', '"x"', 'true', '[1,2]', '{"tariff":"abc"}', '{"tariff":-3}', '{"tariff":null}', '{"tariff":""}', '{"co2":"abc"}']) {
    await page.goto('/');
    await page.evaluate((v) => localStorage.setItem('surya-audit-assumptions', v), bad);
    await page.goto(`/?site=${id}&bad=${encodeURIComponent(bad)}`);
    await expect(page.getByTestId('impact'), bad).toContainText('at Rs 7 per unit (assumption)');
    await expect(page.locator('#co2-line'), bad).toContainText('at 0.675 kg per unit (assumption)');
  }
});

for (const [lng, word] of [['hi', 'मान्यता'], ['pa', 'ਧਾਰਨਾ']]) {
  test(`impact in ${lng}: the CO2 line and the cleanings line carry their numbers and the word for assumption, with no hole`, async ({ page, request }) => {
    const id = await createSite(request);
    await postRows(request, id, syntheticRows());
    await page.goto('/');
    await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lng);
    await page.goto(`/?site=${id}&l=${lng}`);
    for (const sel of ['#co2-line', '#cleanings']) {
      const text = await page.locator(sel).innerText();
      expect(text, sel).toMatch(/[0-9]/);
      expect(text, sel).toContain(word);
      expect(text, sel).not.toMatch(/[{}]|undefined|NaN/);
    }
  });
}

test('Log on a phone: the photo drop zone and the energy field are on the first screen, clear of the tab bar', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 3));
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#panel-log')).toBeVisible();
  expect(await page.locator('.tabs').evaluate((n) => getComputedStyle(n).position)).toBe('fixed');
  const barTop = (await page.locator('#tablist').boundingBox()).y;
  const zone = await page.locator('#photo-pick').boundingBox();
  const field = await page.locator('#kwh-input').boundingBox();
  expect(zone.y + zone.height, 'the drop zone ends above the tab bar').toBeLessThanOrEqual(barTop);
  expect(field.y + field.height, 'the energy field ends above the tab bar').toBeLessThanOrEqual(barTop);
  expect(zone.y).toBeLessThan(field.y);  // the photo comes first
  // The order of the form is the order on screen: energy, then the date, then the period, then Save.
  const order = await page.locator('#reading-form').evaluate((f) => ['#kwh-input', '.datepick', '[name=kind]', '#save-btn'].map((s) => f.querySelector(s).getBoundingClientRect().top));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test('Fix: each suggestion is a row with its status word; one primary Approve, on the first phone screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());  // the whole scenario: two suggestions wait for the owner
  await page.goto(`/?site=${id}#fix`);
  await expect(page.locator('#panel-fix')).toBeVisible();
  const rowsOnFix = page.locator('#action-list > li');
  await expect(rowsOnFix).toHaveCount(2);
  for (let i = 0; i < 2; i++) await expect(rowsOnFix.nth(i).locator('.chip')).toContainText('Waiting for your approval');
  // In each row the status word sits right under the title, before the sentence.
  const order = await rowsOnFix.first().evaluate((li) => ['h3', '.chip', 'p'].map((s) => li.querySelector(s).getBoundingClientRect().top));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Exactly one primary button on the screen: the first suggestion's Approve; the other row's is quiet.
  await expect(page.locator('#action-list .approve-btn:not(.secondary)')).toHaveCount(1);
  const approve = rowsOnFix.first().getByRole('button', { name: 'Approve' });
  expect(await approve.evaluate((n) => n.classList.contains('secondary'))).toBe(false);
  expect(await rowsOnFix.nth(1).getByRole('button', { name: 'Approve' }).evaluate((n) => n.classList.contains('secondary'))).toBe(true);
  // ...and it is on the first phone screen, clear of the tab bar.
  const barTop = (await page.locator('#tablist').boundingBox()).y;
  const box = await approve.boundingBox();
  expect(box.y + box.height, 'Approve ends above the tab bar').toBeLessThanOrEqual(barTop);
});

test('Why: the readings charts sit in a dark band, in light and in dark mode; the causes are a plain section', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  for (const [scheme, bg] of [['light', 'rgb(23, 23, 23)'], ['dark', 'rgb(10, 10, 10)']]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/?site=${id}&s=${scheme}#why`);
    await expect(page.locator('#panel-why')).toBeVisible();
    await expect(page.locator('#chart svg')).toBeVisible();
    const band = await page.locator('#timeline').evaluate((n) => ({ cls: n.className, bg: getComputedStyle(n).backgroundColor, ink: getComputedStyle(n.querySelector('#tl-title')).color }));
    expect(band.cls).toBe('band');
    expect(band.bg).toBe(bg);
    expect(band.ink, 'the heading is light on the dark band').toBe('rgb(237, 237, 237)');
    const causes = await page.locator('#causes').evaluate((n) => ({ cls: n.className, bg: getComputedStyle(n).backgroundColor }));
    expect(causes.cls).toBe('section');
    expect(causes.bg, 'a plain section: the page canvas shows through').toBe('rgba(0, 0, 0, 0)');
  }
  // Only two bands exist on the whole page: Today's hero and this chart.
  expect(await page.locator('.band').evaluateAll((ns) => ns.map((n) => n.id))).toEqual(['hero', 'timeline']);
});

test('Report: a document; Draft is the one primary only when escalation is suggested, the rest are quiet', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  const primaries = () => page.locator('#panel-report button:not(.secondary):not(.share):not(.link)').count();
  await page.goto(`/?site=${id}#report`);
  await expect(page.locator('#panel-report')).toBeVisible();
  expect(await page.locator('#complaint').evaluate((n) => n.tagName)).toBe('SECTION');
  // Nothing has failed to recover yet: no suggestion to complain, so nothing on this tab is shouting.
  await expect(page.locator('#draft-btn')).toHaveClass('secondary');
  expect(await primaries(), 'no primary button before escalation is suggested').toBe(0);
  await page.locator('#draft-btn').click();
  await expect(page.locator('#draft-out')).toBeVisible();
  for (const s of ['#copy-btn', '#download-btn', '#share-draft']) expect(await page.locator(s).evaluate((n) => n.classList.contains('secondary') || n.classList.contains('share')), s + ' is quiet').toBe(true);
  // The suggestion to complain (as the engine reports it after a failed, non-provisional check) makes Draft the one primary.
  const audit = await (await request.get(`/api/sites/${id}/audit`)).json();
  await page.route(`**/api/sites/${id}/audit`, (route) => route.fulfill({ json: { ...audit, escalation: { ...audit.escalation, suggested: true, why: ['Output did not come back after the approved suggestion.'] } } }));
  await page.goto(`/?site=${id}&s=esc#report`);
  await expect(page.locator('#escalation .callout')).toBeVisible();
  await expect(page.locator('#draft-btn')).not.toHaveClass(/secondary/);
  expect(await primaries(), 'Draft is the only primary button').toBe(1);
  // The draft is English and stays editable; the line height is a document's.
  await page.locator('#draft-btn').click();
  const draft = await page.locator('#draft-text').evaluate((n) => ({ lang: n.lang, lh: parseFloat(getComputedStyle(n).lineHeight) / parseFloat(getComputedStyle(n).fontSize) }));
  expect(draft.lang).toBe('en');
  expect(draft.lh).toBeGreaterThanOrEqual(1.5);
});

test('function guards at 375 x 667: each tab has its main action above the tab bar, and a focused field is never covered by it', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  const above = async (sel, why) => {  // polled: the layout may still be settling just after the page shows
    await expect.poll(async () => {
      const bar = (await page.locator('#tablist').boundingBox()).y;
      const box = await page.locator(sel).first().boundingBox();
      return box && box.y >= 0 && box.y + box.height <= bar;
    }, { message: why }).toBe(true);
  };
  await page.goto(`/?site=${id}`);
  await expect(page.getByTestId('headline')).toBeVisible();
  await above('#hero .button:not(.share)', 'Today: "Log a reading" is on the first screen');
  await page.goto(`/?site=${id}#log`);
  await above('#photo-pick', 'Log: the photo drop zone');
  await above('#kwh-input', 'Log: the energy field');
  await page.goto(`/?site=${id}#fix`);
  await above('#action-list .approve-btn:not(.secondary)', 'Fix: the first Approve');
  await page.goto(`/?site=${id}#report`);
  await above('#draft-btn', 'Report: Draft a complaint');
  // A focused field is scrolled clear of the bar (scroll-padding-bottom), wherever it sits on the page.
  const clear = async (sel) => {
    await page.locator(sel).focus();
    await page.waitForTimeout(150);
    const bar = (await page.locator('#tablist').boundingBox()).y;
    const box = await page.locator(sel).boundingBox();
    expect(box.y + box.height, `${sel} is not under the tab bar`).toBeLessThanOrEqual(bar);
  };
  await page.locator('#draft-btn').click();
  await expect(page.locator('#draft-out')).toBeVisible();
  await clear('#draft-text');
  await page.goto(`/?site=${id}&g=2#log`);
  await clear('#kwh-input');
  await page.getByText('Other date').click();
  await clear('input[name=date]');
});

test('print: the Report alone, in light, with the flags and the honesty line, and the whole draft on one page', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.emulateMedia({ colorScheme: 'dark' });  // printing is always light, whatever the screen
  await page.goto(`/?site=${id}#report`);
  await page.locator('#draft-btn').click();
  await expect(page.locator('#draft-out')).toBeVisible();
  await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
  for (const hidden of ['.topbar', '.tabs', '#panel-report button', '#draft-btn']) await expect(page.locator(hidden).first(), hidden).toBeHidden();
  await expect(page.locator('#panel-today')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Complaint draft' })).toBeVisible();
  await expect(page.locator('#banners')).toContainText('Synthetic data');  // the flags travel with the evidence
  await expect(page.locator('footer')).toContainText('not a diagnosis');
  await expect(page.locator('footer')).toContainText('unvalidated heuristic');
  const draft = await page.locator('#draft-text').evaluate((n) => ({ clipped: n.scrollHeight > n.clientHeight + 2, bg: getComputedStyle(document.body).backgroundColor }));
  expect(draft.clipped, 'the whole draft is shown, not a scrolled box').toBe(false);
  expect(draft.bg).toBe('rgb(255, 255, 255)');
  const pdf = await page.pdf({ format: 'A4', margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' } });
  expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 'one page').toBe(1);
});

test('v3 type and touch sizes on a phone: body 18 px, primary controls 56 px or more, the rest 48 px or more, the wordmark takes the text colour', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}#fix`);
  await expect(page.locator('#action-list .approve-btn:not(.secondary)')).toBeVisible();
  const px = (sel, prop) => page.locator(sel).first().evaluate((n, p) => parseFloat(getComputedStyle(n)[p]), prop);
  expect(await px('body', 'fontSize')).toBe(18);
  expect(await px('#action-list .approve-btn:not(.secondary)', 'height')).toBeGreaterThanOrEqual(56);
  expect(await px('#action-list .approve-btn.secondary', 'height')).toBeGreaterThanOrEqual(48);
  expect(await px('#action-list .speak', 'height')).toBeGreaterThanOrEqual(48);
  await page.goto(`/?site=${id}&v=3#log`);
  await expect(page.locator('#panel-log')).toBeVisible();
  expect(await px('#save-btn', 'height')).toBeGreaterThanOrEqual(64);  // the hero button keeps its 64 px
  for (const sel of ['#kwh-input', '#photo-pick', '[role=tab]', '.lang button']) expect(await px(sel, 'height'), sel).toBeGreaterThanOrEqual(48);
  // The wordmark sun is inline SVG drawn in currentColor: no colour of its own.
  const mark = await page.locator('.brand svg').evaluate((n) => ({ html: n.outerHTML, fill: getComputedStyle(n.querySelector('circle')).fill, ink: getComputedStyle(n).color }));
  expect(mark.html).not.toMatch(/#[0-9a-f]{3,6}/i);
  expect(mark.fill).toBe(mark.ink);
});

test('page height at 375 px stays under 8 screens on every tab, in English, Hindi and Punjabi', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'sets its own viewport');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  const heights = {};
  for (const lng of ['en', 'hi', 'pa']) {
    await page.goto('/');
    await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lng);
    for (const tab of ['today', 'log', 'fix', 'why', 'report']) {
      await page.goto(`/?site=${id}&h=${lng}${tab}#${tab}`);
      await expect(page.locator(`#panel-${tab}`)).toBeVisible();
      if (tab === 'why') await expect(page.locator('#chart svg')).toBeVisible();
      if (tab === 'report') { await page.locator('#draft-btn').click(); await expect(page.locator('#draft-out')).toBeVisible(); }
      heights[`${lng}/${tab}`] = await page.evaluate(() => document.documentElement.scrollHeight);
    }
  }
  testInfo.annotations.push({ type: 'heights', description: JSON.stringify(heights) });
  console.log('page heights at 375 px:', JSON.stringify(heights));
  for (const [key, h] of Object.entries(heights)) expect(h, `${key} is ${(h / 667).toFixed(1)} screens`).toBeLessThan(8 * 667);
});

test('offline: a busy server leaves waiting readings queued, a refusal drops them with its message, and an empty queue leaves no key', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}#log`);
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));
  for (const [date, value] of [['2026-08-20', '9.9'], ['2026-08-21', '8.8']]) {
    await setReadingDate(page, date);
    await page.getByLabel('Energy produced (kWh)').fill(value);
    await page.getByRole('button', { name: 'Save reading' }).click();
    await expect(page.locator('#queue')).toBeVisible();
  }
  await expect(page.locator('#queue')).toContainText('2 readings');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('surya-audit-queued-readings') || '[]').map((q) => q.body.date));
  expect(await stored()).toEqual(['2026-08-20', '2026-08-21']);
  // 5xx: nothing is dropped.
  await page.unroute('**/readings');
  await page.route('**/readings', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.locator('#queue')).toContainText('2 readings');
  expect(await stored()).toEqual(['2026-08-20', '2026-08-21']);
  // 429: the same.
  await page.unroute('**/readings');
  await page.route('**/readings', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.locator('#queue')).toContainText('2 readings');
  // A refusal (422) drops the reading with the server's message; the key is removed once the queue is empty.
  await page.unroute('**/readings');
  await page.route('**/readings', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'That value is not possible.' }) }));
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.locator('#queue')).toBeHidden();
  await expect(page.locator('#error')).toContainText('That value is not possible.');
  expect(await page.evaluate(() => localStorage.getItem('surya-audit-queued-readings'))).toBeNull();
});

test('offline: saving a day again while it waits replaces the waiting reading, so the old value is never sent later', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows().slice(0, 2));
  await page.goto(`/?site=${id}#log`);
  await page.route('**/readings', (route) => route.abort('internetdisconnected'));
  await setReadingDate(page, '2026-08-20');
  await page.getByLabel('Energy produced (kWh)').fill('9.9');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#queue')).toBeVisible();
  await page.unroute('**/readings');
  page.once('dialog', (dialog) => dialog.accept());
  await setReadingDate(page, '2026-08-20');
  await page.getByLabel('Energy produced (kWh)').fill('10.1');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading');
  await expect(page.locator('#queue')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('surya-audit-queued-readings'))).toBeNull();
  const saved = (await (await request.get(`/api/sites/${id}/audit`)).json()).timeline;
  expect(saved.map((p) => `${p.date}:${p.kwh}`)).toContain('2026-08-20:10.1');
});

test('replay: leaving Why stops it and the chart is whole again; the caption is not a live region', async ({ page, request }) => {
  const id = await createSite(request);
  await postRows(request, id, syntheticRows());
  await page.goto(`/?site=${id}#why`);
  await expect(page.locator('#chart svg')).toBeVisible();
  expect(await page.locator('#replay-caption').getAttribute('aria-live')).toBeNull();  // 60 updates in seconds must not be read out
  await page.getByRole('button', { name: 'Replay the 60 days' }).click();
  await expect(page.locator('#replay-caption')).toContainText('Day ');
  await openTab(page, 'Fix');
  await expect(page.locator('#replay-caption')).toHaveText('');
  await openTab(page, 'Why');
  await expect(page.locator('#chart path.bar:not(.hold)')).toHaveCount(60);
  await expect(page.getByRole('button', { name: 'Replay the 60 days' })).toBeVisible();
});
