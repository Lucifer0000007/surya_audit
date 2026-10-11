// The owner's whole loop on a phone: 375 px, touch, a slow network, Gemini mocked at the network layer.
// Fails on any console error or warning, page error, CSP violation or request to another origin.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENS = path.join(ROOT, 'local_screens');
// A valid 1x1 PNG: the mocked Gemini reply does not depend on the picture.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.use({
  viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  permissions: ['geolocation', 'clipboard-read', 'clipboard-write'], geolocation: { latitude: 26.8467, longitude: 80.9462 },
});
test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'mobile', 'the phone flow runs once, in the mobile project'));

function syntheticRows() {
  const [header, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  const keys = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));
}

// A plant the API labels synthetic (fixtures/synthetic_site.json), with the synthetic readings: its banner, screenshots and
// complaint draft all say SYNTHETIC. The setup wizard cannot set that flag, so the wizard's own plant carries no readings.
async function syntheticPlant(request) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).id;
  for (const r of syntheticRows()) {
    const res = await request.post(`/api/sites/${id}/readings`, { data: { date: r.date, kwh: Number(r.kwh), kind: r.kind || 'daily' } });
    expect(res.ok()).toBeTruthy();
  }
  return id;
}

// Keyboard activation takes the same path as a tap without depending on the fixed bar's hit geometry (see audit.spec.js).
async function openTab(page, name) {
  await page.getByRole('tab', { name, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

// Everything that should never happen on a page: collected while the flow runs, asserted at the end.
async function watch(page, problems, origin) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.console.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => problems.pageErrors.push(String(e.message).slice(0, 200)));
  page.on('request', (r) => {
    const url = r.url();
    if (/^https?:/i.test(url) && new URL(url).origin !== origin) problems.external.push(url);
  });
  await page.exposeFunction('reportViolation', (what) => problems.csp.push(what));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.reportViolation(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

// DevTools' "Fast 3G": 1.6 Mbit/s down, 750 kbit/s up, 150 ms latency.
async function throttle(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
}

async function expectNoSideScroll(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('phone flow: set up, read a photo, save, replace, approve, draft a complaint, share the link, set up again', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL).origin;
  const problems = { console: [], pageErrors: [], csp: [], external: [] };
  await watch(page, problems, origin);
  await throttle(page);
  // Screenshots of the synthetic plant carry SYNTHETIC in their names: they must never pass for a real plant's.
  const shot = (name) => page.screenshot({ path: path.join(SCREENS, `flow-${name}.png`), fullPage: true });

  // 1. Setup wizard: the phone's position is rounded to about 1 km (two decimals) before it is used.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByLabel('Latitude')).toHaveValue('26.85');  // the phone said 26.8467
  await expect(page.getByLabel('Longitude')).toHaveValue('80.95');  // the phone said 80.9462
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Plant size (kW)').fill('3');
  await page.getByRole('button', { name: 'Next' }).click();
  await shot('wizard-3');
  await page.getByRole('button', { name: 'Start auditing' }).click();
  await expect(page.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Sample values in use', { exact: true })).toBeVisible();  // no system loss was given
  const ownLink = await page.locator('#plant-link').getAttribute('href');
  const ownId = new URL(ownLink, baseURL).searchParams.get('site');
  expect(ownId).toBeTruthy();

  // From here on the plant is the synthetic one, opened by its link. This browser remembers the wizard's plant, so the
  // page asks whether to remember this one instead; accepting it is part of the flow.
  const id = await syntheticPlant(request);
  const asked = [];
  page.once('dialog', (dialog) => { asked.push(dialog.message()); dialog.accept(); });
  await page.goto(`/?site=${id}`);
  await expect(page.getByText('Synthetic data', { exact: true })).toBeVisible();
  await expect(page.getByTestId('headline')).toContainText('Top possible cause: Sudden fault');
  expect(asked[0]).toContain('opens a different plant from the one this browser remembers');
  const link = await page.locator('#plant-link').getAttribute('href');
  expect(link).toBe(`/?site=${id}`);
  await shot('SYNTHETIC-today');

  // 2. A photo, read by the mocked Gemini: the values fill the form and nothing is saved yet.
  await openTab(page, 'Log');
  const extractCalls = [];
  await page.route('**/api/sites/*/extract', async (route) => {
    extractCalls.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        candidate: { date: '2026-10-04', kwh: 7.7, kind: 'daily', cumulative_meter_kwh: null, what_was_read: 'Inverter app: yield today' },
        saved: false, confirm_required: true, synthetic: true, sample: true, heuristic: true,
      }),
    });
  });
  await page.locator('#photo').setInputFiles({ name: 'inverter.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
  await expect(page.locator('#photo-note')).toContainText('Check the values below and correct them before you save. Nothing is saved yet.');
  await expect(page.getByLabel('Energy produced (kWh)', { exact: true })).toHaveValue('7.7');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-10-04');
  expect(extractCalls).toHaveLength(1);
  expect(extractCalls[0].mime_type).toBe('image/jpeg');  // re-encoded on the phone, whatever the file was
  expect(Buffer.from(extractCalls[0].image_base64, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
  const readings = async () => (await (await request.get(`/api/sites/${id}/audit`)).json()).timeline;
  expect(await readings()).toHaveLength(60);  // the photo alone saved nothing
  await shot('SYNTHETIC-log-photo');

  // 3. The owner corrects the value and saves it.
  await page.getByLabel('Energy produced (kWh)', { exact: true }).fill('7.6');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.locator('#status')).toContainText('Saved the reading for');
  const timeline = await readings();
  expect(timeline).toHaveLength(61);
  expect(timeline[60]).toMatchObject({ date: '2026-10-04', kwh: 7.6 });

  // 4. The same date again asks first: dismissing keeps the saved value, accepting replaces it.
  const replaced = [];
  page.once('dialog', (dialog) => { replaced.push(dialog.message()); dialog.dismiss(); });
  await page.getByLabel('Energy produced (kWh)', { exact: true }).fill('7.9');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect.poll(() => replaced.length).toBe(1);
  expect(replaced[0]).toContain('is already saved (7.6 kWh). Replace it?');
  expect((await readings())[60].kwh).toBe(7.6);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect.poll(async () => (await readings())[60].kwh).toBe(7.9);
  await expect(page.locator('#photo-review')).toBeHidden();

  // 5. Fix: the owner approves a suggestion; checking the next readings starts. Nothing was approved before.
  await openTab(page, 'Fix');
  const check = page.getByTestId('action-check_inverter');
  await expect(check).toContainText('Waiting for your approval');
  await check.getByRole('button', { name: 'Approve' }).tap();
  await expect(page.getByTestId('action-check_inverter')).toContainText('Checking the next readings');
  await shot('SYNTHETIC-fix');

  // 6. Report: a draft with placeholders, labelled synthetic, copied to the clipboard; nothing is sent.
  await openTab(page, 'Report');
  await page.getByRole('button', { name: 'Draft a complaint' }).tap();
  const draft = page.getByLabel('Draft complaint');
  await expect(draft).toHaveValue(/^SYNTHETIC DATA/);
  await expect(draft).toHaveValue(/<<OWNER TO FILL: /);
  await expect(page.getByText('Nothing has been sent.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy text' }).tap();
  await expect(page.locator('#status')).toHaveText('Draft copied.');
  // Chromium on Windows hands the clipboard text back with CRLF line ends; the draft itself uses LF.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(await draft.inputValue());
  await shot('SYNTHETIC-report');

  // 7. No tab scrolls sideways at 375 px.
  for (const tab of ['Today', 'Log', 'Fix', 'Why', 'Report']) {
    await openTab(page, tab);
    await expectNoSideScroll(page);
  }

  // 8. The plant's link opens the same plant on another phone (a fresh browser context).
  await openTab(page, 'Today');
  const other = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const otherPage = await other.newPage();
  await watch(otherPage, problems, origin);
  await throttle(otherPage);
  await otherPage.goto(link);
  await expect(otherPage.getByRole('tab', { name: 'Today', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(otherPage.getByText('Synthetic data', { exact: true })).toBeVisible();
  await openTab(otherPage, 'Why');
  await expect(otherPage.locator('#chart path.bar')).toHaveCount(60);  // the chart shows the latest 60 readings
  await expect(otherPage.locator('#tl-sub')).toContainText('Showing the latest 60 of 61');  // and says so; the table lists all
  await other.close();

  // 9. Setting the plant up again asks first, shows the wizard, and the link still opens the plant with its readings.
  const confirms = [];
  page.once('dialog', (dialog) => { confirms.push(dialog.message()); dialog.accept(); });
  await page.getByRole('button', { name: 'Set up the plant again' }).tap();
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  expect(confirms[0]).toContain('This plant’s readings stay saved');
  await page.goto(link);
  await openTab(page, 'Why');
  await expect(page.locator('#tl-sub')).toContainText('Showing the latest 60 of 61');  // all 61 readings are still there

  // Nothing went wrong in the background.
  expect(problems).toEqual({ console: [], pageErrors: [], csp: [], external: [] });
});

// The ways a photo or a request can fail: each leaves the owner a way forward, and nothing is half-saved.
test('phone flow: a busy or unreadable photo, a lifetime-only meter, a weekly total, a bad date, a failed approve and draft, a refused location', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL).origin;
  const problems = { console: [], pageErrors: [], csp: [], external: [] };
  await watch(page, problems, origin);
  await throttle(page);

  const id = await syntheticPlant(request);
  const readingPosts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/readings')) readingPosts.push(r.postDataJSON()); });
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#panel-log')).toBeVisible();  // the plant has loaded: a late first render would take focus back

  // Gemini, mocked: whatever `reply` holds is what the next photo gets.
  let reply;
  await page.route('**/api/sites/*/extract', (route) => route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) }));
  // Picks a photo and waits until the page has processed the reply, so no assertion can pass before it.
  const pick = async () => {
    const answered = page.waitForResponse((r) => r.url().includes('/extract'));
    await page.locator('#photo').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64') });
    await answered;
    await expect(note).not.toHaveText(/Reading your photo/);
  };
  const read = (candidate) => ({ status: 200, body: { candidate: { date: null, kwh: null, kind: null, cumulative_meter_kwh: null, what_was_read: '', ...candidate }, saved: false, confirm_required: true, synthetic: true, sample: true, heuristic: true } });
  const note = page.locator('#photo-note');
  const kwhField = page.locator('#kwh-input');
  const period = page.locator('input[name=kind]:checked');  // the Period choice is a segmented control (radios)
  const dateField = page.getByLabel('Date', { exact: true });
  const today = page.getByRole('radio', { name: 'Today' });
  const NOTHING = 'Could not find an energy value in this photo. Type the reading by hand.';

  // Gemini is busy, or could not read it, or the gateway timed out: the note says so and the field is ready to type in.
  reply = { status: 503, body: { detail: 'Photo reading is busy right now. Try again in a minute, or type the reading by hand.' } };
  await pick();
  await expect(note).toContainText('Photo reading is busy right now. Try again in a minute');
  await expect(note).toContainText('The photo was not saved.');
  await expect(kwhField).toBeFocused();
  reply = { status: 502, body: { detail: 'Could not read the photo. Please type the reading by hand.' } };
  await pick();
  await expect(note).toContainText('Could not read the photo. Please type the reading by hand.');
  reply = { status: 504, body: { message: 'Endpoint request timed out' } };
  await pick();
  await expect(note).toContainText('Surya Audit could not finish that just now. Please try again in a moment.');
  expect(readingPosts).toEqual([]);  // none of this saved anything

  // A meter that shows only its lifetime total: the owner is told what to enter instead; nothing is filled in.
  reply = read({ cumulative_meter_kwh: 15234.5, what_was_read: 'Meter: total energy' });
  await pick();
  await expect(note).toContainText('lifetime total of 15,234.5 kWh');
  await expect(kwhField).toHaveValue('');
  await expect(page.locator('#save-btn')).toHaveAttribute('aria-disabled', 'true');

  // A weekly total fills the period too.
  reply = read({ date: '2026-10-04', kwh: 52.3, kind: 'weekly', what_was_read: 'Weekly total' });
  await pick();
  await expect(kwhField).toHaveValue('52.3');
  await expect(period).toHaveValue('weekly');

  // A date Gemini wrote in another format is not guessed: the date stays empty, the form refuses, and nothing is sent.
  reply = read({ date: '04/10/2026', kwh: 7.7, kind: 'weekly', what_was_read: 'Yesterday total' });
  await pick();
  await expect(kwhField).toHaveValue('7.7');
  await expect(period).toHaveValue('weekly');
  await expect(dateField).toHaveValue('');
  await page.getByRole('button', { name: 'Save reading' }).click();
  await expect(dateField).toBeFocused();
  expect(readingPosts).toEqual([]);

  // Nothing readable at all: the note says so (it must not ask the owner to "check the values" of an empty form), and
  // the values the previous photo filled in are gone: the energy, the period and the date are back to a fresh form.
  reply = read({});
  await pick();
  await expect(note).toContainText(NOTHING);  // this also waits for the reply
  await expect(note).not.toContainText('Check the values below');
  await expect(kwhField).toHaveValue('');
  await expect(period).toHaveValue('daily');
  await expect(today).toBeChecked();
  await expect(note).toHaveAttribute('role', 'status');  // a live region: the result is announced

  // What a photo filled in is one unit: once the owner has changed any of it, a new photo leaves all of it alone.
  reply = read({ date: '2026-10-04', kwh: 52.3, kind: 'weekly', what_was_read: 'Weekly total' });
  await pick();
  await expect(kwhField).toHaveValue('52.3');
  await kwhField.fill('50');
  reply = read({});
  await pick();
  await expect(note).toContainText(NOTHING);
  await expect(kwhField).toHaveValue('50');
  await expect(period).toHaveValue('weekly');
  await expect(dateField).toHaveValue('2026-10-04');

  // Discard: what the owner changed stays theirs; what a photo filled in and nobody touched goes with the photo.
  await page.reload();
  await expect(page.locator('#panel-log')).toBeVisible();
  reply = read({ date: '2026-10-04', kwh: 52.3, kind: 'weekly', what_was_read: 'Weekly total' });
  await pick();
  await kwhField.fill('50');
  await page.locator('#photo-clear').click();
  await expect(kwhField).toHaveValue('50');
  await expect(period).toHaveValue('weekly');
  await expect(dateField).toHaveValue('2026-10-04');
  await page.reload();
  await expect(page.locator('#panel-log')).toBeVisible();
  reply = read({ date: '2026-10-04', kwh: 7.7, kind: 'weekly', what_was_read: 'Weekly total' });
  await pick();
  await expect(kwhField).toHaveValue('7.7');
  await expect(period).toHaveValue('weekly');
  await page.locator('#photo-clear').click();
  await expect(kwhField).toHaveValue('');
  await expect(period).toHaveValue('daily');
  await expect(today).toBeChecked();

  // A reply that holds only a period (no energy), only a date nobody can parse, or no candidate at all (Gemini gave nothing)
  // is "nothing readable": the form stays a fresh one.
  reply = read({ kind: 'weekly' });
  await pick();
  await expect(note).toContainText(NOTHING);
  await expect(period).toHaveValue('daily');  // a period without an energy value is not taken
  reply = read({ date: '04/10/2026' });
  await pick();
  await expect(note).toContainText(NOTHING);
  await expect(note).not.toContainText('Check the values below');
  await expect(dateField).toHaveValue('');
  reply = { status: 200, body: { candidate: null, saved: false, confirm_required: true, synthetic: true, sample: true, heuristic: true } };
  await pick();
  await expect(note).toContainText(NOTHING);
  await expect(today).toBeChecked();  // the unparseable date's empty "Other date" is gone too
  expect(readingPosts).toEqual([]);

  // A failed approve says so, keeps the suggestion waiting and lets the owner try again.
  await openTab(page, 'Fix');
  await page.route('**/api/sites/*/actions/*/approve', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  const check = page.getByTestId('action-check_inverter');
  const approve = check.getByRole('button', { name: 'Approve' });
  await approve.tap();
  await expect(page.locator('#error')).toContainText('Surya Audit could not finish that just now. Please try again in a moment.');
  await expect(approve).toBeEnabled();
  await expect(check).toContainText('Waiting for your approval');
  await page.unroute('**/api/sites/*/actions/*/approve');
  await approve.tap();
  await expect(page.getByTestId('action-check_inverter')).toContainText('Checking the next readings');
  await expect(page.locator('#error')).toBeHidden();

  // A failed draft says so, shows no half draft, and works on the next try.
  await openTab(page, 'Report');
  await page.route('**/api/sites/*/complaint', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: 'Draft a complaint' }).tap();
  await expect(page.locator('#error')).toContainText('could not finish that just now');
  await expect(page.locator('#draft-out')).toBeHidden();
  await page.unroute('**/api/sites/*/complaint');
  await page.getByRole('button', { name: 'Draft a complaint' }).tap();
  await expect(page.getByLabel('Draft complaint')).toHaveValue(/<<OWNER TO FILL: /);
  await expect(page.locator('#error')).toBeHidden();

  // A refused location permission (code 1) and a position that takes too long (code 3, the browser's own timeout) both
  // leave the coordinates to type; the error goes away on the next try, and a working one fills the fields.
  const noGeo = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const geoPage = await noGeo.newPage();
  await geoPage.addInitScript(() => {
    window.geoMode = 'denied';
    window.geoCalls = 0;
    navigator.geolocation.getCurrentPosition = (ok, fail, options) => {
      window.geoOptions = options;
      window.geoCalls += 1;
      if (window.geoMode === 'hang') return;  // the browser never answers: an unanswered permission prompt
      setTimeout(() => (window.geoMode === 'ok' ? ok({ coords: { latitude: 26.8467, longitude: 80.9462 } }) : fail({ code: window.geoMode === 'timeout' ? 3 : 1 })), 0);
    };
  });
  await geoPage.clock.install();
  await geoPage.goto('/');
  const locate = geoPage.getByRole('button', { name: 'Use my location' });
  await locate.click();
  await expect(geoPage.getByRole('alert')).toContainText('Could not get your location. Type the latitude and longitude instead.');
  expect(await geoPage.evaluate(() => window.geoOptions)).toEqual({ timeout: 10000 });  // a missing fix cannot hang forever
  await geoPage.evaluate(() => { window.geoMode = 'timeout'; });
  await locate.click();
  await expect(geoPage.getByRole('alert')).toContainText('Could not get your location.');
  // A request the browser never answers blocks a second tap (one request at a time), and expires after 12 s.
  await geoPage.evaluate(() => { window.geoMode = 'hang'; window.geoCalls = 0; });
  await locate.click();
  await locate.click();
  expect(await geoPage.evaluate(() => window.geoCalls)).toBe(1);
  await geoPage.clock.fastForward(13_000);
  await geoPage.evaluate(() => { window.geoMode = 'ok'; });
  await locate.click();
  await expect(geoPage.getByRole('alert')).toBeHidden();  // the old error did not outlive the new try
  await expect(geoPage.locator('#status')).toHaveText('Location filled in.');
  await expect(geoPage.getByLabel('Latitude')).toHaveValue('26.85');
  await geoPage.getByRole('button', { name: 'Next' }).click();
  await expect(geoPage.getByLabel('Plant size (kW)')).toBeVisible();
  await noGeo.close();

  // The injected failures are the only console errors: the browser logs each failed response it was handed.
  expect(problems.console.filter((m) => !m.includes('Failed to load resource'))).toEqual([]);
  expect({ ...problems, console: [] }).toEqual({ console: [], pageErrors: [], csp: [], external: [] });
});
