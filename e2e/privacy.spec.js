// What the page says about the owner's data, checked against what it does: the privacy band, the region, the coordinates,
// and "Forget this plant on this device". Runs against the offline API (fixtures, no Gemini key).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// A plant the API labels synthetic (fixtures/synthetic_site.json), with the synthetic readings.
async function syntheticPlant(request) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  const [header, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  const keys = header.split(',');
  for (const line of lines) {
    const row = Object.fromEntries(line.split(',').map((v, i) => [keys[i], v]));
    const res = await request.post(`/api/sites/${id}/readings`, { data: { date: row.date, kwh: Number(row.kwh), kind: row.kind || 'daily' } });
    expect(res.ok()).toBeTruthy();
  }
  return id;
}

test('privacy band: it says what the code does, states the region only from the deploy host, and claims nothing it cannot back', async ({ page, request, baseURL }) => {
  const id = await syntheticPlant(request);
  await page.goto(`/?site=${id}`);
  const band = page.locator('#privacy');
  await expect(band.getByRole('heading', { name: 'What happens to your data' })).toBeVisible();
  const text = await band.innerText();
  for (const claim of [
    'No accounts: your plant’s private link is the only key, so keep it private.',
    'Photos are shrunk on your phone, which drops their location data.',
    'Google Gemini reads them under Google’s own terms; Surya Audit does not keep them.',
    // A local run is not served from an API Gateway host, so no region is stated.
    'Readings and plant details are stored in AWS, in DynamoDB, which encrypts them at rest by default.',
    'The plant’s location goes to NASA POWER (weather) and, with its size, tilt, direction and loss, to PVGIS (expected output).',
    'rounded to about 1 km if it comes from your phone, and used as typed otherwise.',
    'Nothing is sent for you: a complaint draft is yours to copy and file.',
    'Clears this browser only. Readings stay saved on the server; the plant’s link still opens them.',
  ]) expect(text).toContain(claim);
  // What the band must not claim: deletion, accounts to log in to, a diagnosis, shading detection, inverter integration.
  for (const word of [/\bdelet/i, /\berase/i, /\bsign in\b|\blog in\b/i, /shading/i, /integrat/i, /diagnos/i]) expect(text).not.toMatch(word);

  // The region is read from the API Gateway host name (which the deploy command fixes), never assumed.
  const labels = await page.evaluate(() => [
    regionLabelFor('abc123.execute-api.ap-south-1.amazonaws.com'), regionLabelFor('abc123.execute-api.eu-west-2.amazonaws.com'),
    regionLabelFor('127.0.0.1'), regionLabelFor('example.com'), regionLabelFor('x.execute-api.ap-south-1.amazonaws.com.attacker.net')]);
  expect(labels).toEqual([' Mumbai (ap-south-1)', ' eu-west-2', '', '', '']);

  // Served from such a host (a local stand-in: every request to it is answered by this test's own server, nothing leaves),
  // the band names the region in each language.
  const host = 'https://abc123.execute-api.ap-south-1.amazonaws.com';
  await page.route(`${host}/**`, async (route) => {
    const url = new URL(route.request().url());
    const upstream = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` });
    await route.fulfill({ response: upstream });
  });
  await page.goto(`${host}/?site=${id}`);
  await expect(page.locator('#privacy')).toContainText('stored in AWS Mumbai (ap-south-1), in DynamoDB, which encrypts them at rest by default.');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('#privacy')).toContainText('AWS मुंबई (ap-south-1) में, DynamoDB में रखा जाता है');
  await page.getByRole('button', { name: 'ਪੰਜਾਬੀ' }).click();
  await expect(page.locator('#privacy')).toContainText('AWS ਮੁੰਬਈ (ap-south-1) ਵਿੱਚ, DynamoDB ਵਿੱਚ ਰੱਖਿਆ ਜਾਂਦਾ ਹੈ');
});

test('plant coordinates are stored as given: rounded only by "Use my location", never by the server', async ({ request }) => {
  const res = await request.post('/api/sites', { data: { lat: 26.84671, lon: 80.94623, kw: 3, tilt: 27, azimuth: 180 } });
  const { id } = await res.json();
  const audit = await (await request.get(`/api/sites/${id}/audit`)).json();
  expect([audit.site.lat, audit.site.lon]).toEqual([26.84671, 80.94623]);  // typed with five decimals, kept with five
});

test('Forget this plant on this device clears this browser only: the readings stay saved and the link still opens them', async ({ page, request }) => {
  const id = await syntheticPlant(request);
  await page.goto(`/?site=${id}`);
  await expect(page.getByTestId('headline')).toBeVisible();
  // Give the browser something to forget besides the plant itself: an edited assumption.
  await page.locator('#impact summary').click();
  await page.getByTestId('impact').getByLabel(/Tariff, Rs per unit/).fill('9');
  await page.getByRole('button', { name: 'Use these values' }).click();
  const keys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('surya-audit-')).sort());
  expect(await keys()).toEqual(['surya-audit-assumptions', `surya-audit-last:${id}`, 'surya-audit-site']);  // the saved result is one of the things this browser keeps

  // Dismissing the question changes nothing.
  const asked = [];
  page.once('dialog', (dialog) => { asked.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  expect(asked[0]).toContain('This clears this browser only: readings stay saved on the server');
  expect(asked[0]).toContain(`/?site=${id}`);
  expect(await keys()).toEqual(['surya-audit-assumptions', `surya-audit-last:${id}`, 'surya-audit-site']);  // the saved result is one of the things this browser keeps
  await expect(page.getByTestId('headline')).toBeVisible();

  // Accepting forgets the plant and the assumptions in this browser, and says what stayed. It sends no request at all.
  await page.evaluate(() => { localStorage.setItem('surya-audit-lang', 'en'); localStorage.setItem('surya-audit-bigger', '1'); });
  const sent = [];
  page.on('request', (req) => sent.push(`${req.method()} ${req.url()}`));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Plant forgotten on this device. Its readings stay saved on the server, and its link still opens them.');
  expect(sent, 'forgetting is local: no request leaves the page').toEqual([]);
  expect(await keys()).toEqual(['surya-audit-bigger', 'surya-audit-lang']);  // the plant and the assumptions are gone; the owner's own choices stay
  expect(new URL(page.url()).search).toBe('');
  page.removeAllListeners('request');

  // The server kept everything, and the link opens the plant again with nothing to confirm.
  const audit = await (await request.get(`/api/sites/${id}/audit`)).json();
  expect(audit.timeline).toHaveLength(60);
  await page.goto(`/?site=${id}`);
  await expect(page.getByTestId('headline')).toContainText('Top possible cause: Sudden fault');

  // The same button in Hindi and Punjabi.
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.getByRole('button', { name: 'इस डिवाइस पर इस प्लांट को भूल जाएँ' })).toBeVisible();
  await page.getByRole('button', { name: 'ਪੰਜਾਬੀ' }).click();
  await expect(page.getByRole('button', { name: 'ਇਸ ਡਿਵਾਈਸ ਉੱਤੇ ਇਸ ਪਲਾਂਟ ਨੂੰ ਭੁੱਲ ਜਾਓ' })).toBeVisible();
});

test('Built on AWS and How it runs: one line, an expander of six lines, and the region only from the deploy host', async ({ page, request, baseURL }) => {
  const id = await syntheticPlant(request);
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#aws')).toContainText('Built on AWS: Lambda, API Gateway, DynamoDB, EventBridge Scheduler, Parameter Store.');
  const how = page.locator('#how-runs');
  await expect(how.locator('li:visible')).toHaveCount(0);  // collapsed until opened
  await how.locator('summary').click();
  await expect(how.locator('li:visible')).toHaveCount(6);  // a local run is not served from an API Gateway host: no region line
  await expect(how).toContainText('Daily at 09:00 India time, an EventBridge Scheduler schedule runs a second Lambda function');
  await expect(how).toContainText('Not on AWS: Google Gemini reads photos; NASA POWER and PVGIS supply weather and expected output.');

  // From an API Gateway host (a stand-in answered by this test's own server) the region line appears, in each language.
  const host = 'https://abc123.execute-api.ap-south-1.amazonaws.com';
  await page.route(`${host}/**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` }) });
  });
  await page.goto(`${host}/?site=${id}`);
  await page.locator('#how-runs summary').click();
  await expect(page.locator('#how-runs li:visible')).toHaveCount(7);
  await expect(page.locator('#run-region')).toHaveText('Region: Mumbai (ap-south-1)');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('#run-region')).toHaveText('रीजन: मुंबई (ap-south-1)');
  await expect(page.locator('#aws')).toContainText('AWS पर बना: Lambda, API Gateway, DynamoDB, EventBridge Scheduler, Parameter Store।');
  await page.getByRole('button', { name: 'ਪੰਜਾਬੀ' }).click();
  await expect(page.locator('#run-region')).toHaveText('ਰੀਜਨ: ਮੁੰਬਈ (ap-south-1)');
});

test('Forget does not wipe a different plant that this browser remembers', async ({ page, request }) => {
  const remembered = await syntheticPlant(request);
  const other = await syntheticPlant(request);
  await page.goto(`/?site=${remembered}`);  // remembered in this browser
  await expect(page.getByTestId('headline')).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());  // "open this plant instead?": no, keep what is remembered
  await page.goto(`/?site=${other}&again=1`);
  await expect(page.getByTestId('headline')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('surya-audit-site'))).toBe(remembered);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('surya-audit-site')), 'the other plant is still remembered').toBe(remembered);
});
