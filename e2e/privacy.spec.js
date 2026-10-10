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
  expect(await keys()).toEqual(['surya-audit-assumptions', 'surya-audit-site']);

  // Dismissing the question changes nothing.
  const asked = [];
  page.once('dialog', (dialog) => { asked.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  expect(asked[0]).toContain('This clears this browser only: readings stay saved on the server');
  expect(asked[0]).toContain(`/?site=${id}`);
  expect(await keys()).toEqual(['surya-audit-assumptions', 'surya-audit-site']);
  await expect(page.getByTestId('headline')).toBeVisible();

  // Accepting forgets the plant and the assumptions in this browser, and says what stayed.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Forget this plant on this device' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your plant' })).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Plant forgotten on this device. Its readings stay saved on the server, and its link still opens them.');
  expect(await keys()).toEqual([]);
  expect(new URL(page.url()).search).toBe('');

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
