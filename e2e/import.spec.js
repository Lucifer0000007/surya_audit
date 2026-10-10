// Step 8: adding many days at once on Log, from pasted lines or a CSV file. All data here is synthetic: the plant is created
// from fixtures/synthetic_site.json and the readings come from fixtures/synthetic_site.csv. Runs against the offline API.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-10-11T10:00:00');

function csvRows() {  // [{date, kwh}] from the synthetic scenario
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  return lines.map((l) => { const [date, kwh] = l.split(','); return { date, kwh }; });
}
const dmy = (iso) => iso.split('-').reverse().join('/');  // 2026-08-06 -> 06/08/2026

async function newPlant(request, readings = 0) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  for (const r of csvRows().slice(0, readings)) {
    expect((await request.post(`/api/sites/${id}/readings`, { data: { date: r.date, kwh: Number(r.kwh), kind: 'daily' } })).ok()).toBeTruthy();
  }
  return id;
}
const timeline = async (request, id) => (await (await request.get(`/api/sites/${id}/audit`)).json()).timeline;

async function openImport(page, id, lang) {
  await page.clock.setFixedTime(NOW);
  if (lang) { await page.goto('/'); await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lang); }
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#panel-log')).toBeVisible();
  await page.locator('#import > summary').click();
  await expect(page.locator('#import-text')).toBeVisible();
}
const paste = (page, lines) => page.locator('#import-text').fill(lines.join('\n'));
const check = (page) => page.locator('#import-check').click();
const rowsOf = (page) => page.locator('#import-list > li');

test('import: lines in the two formats are checked and shown; anything else is refused with the reason; nothing is saved yet', async ({ page, request }) => {
  const id = await newPlant(request);
  await openImport(page, id);
  await paste(page, [
    'date,kwh',  // a header line is skipped
    '2026-09-28,6.2',
    '29/09/2026,6.4',
    '30/09/2026,6.1',
    '03-10-2026,5.9',  // dashes with the day first: could be read two ways
    '31/02/2026,5.0',  // not a day
    '2026-09-27,abc',
    '2026-09-26,12,4',  // a decimal comma
    '2026-09-25,7.0',
    '25/09/2026,7.1',  // the same day again
    '2099-01-01,5',  // in the future
  ]);
  await check(page);
  await expect(page.locator('#import-sum')).toHaveText('4 ready to save, 6 to fix. Lines with a problem are not saved.');
  await expect(rowsOf(page)).toHaveCount(10);
  const text = await rowsOf(page).allInnerTexts();
  expect(text[0]).toContain('28 Sept 2026');
  expect(text[0]).toContain('Ready');
  expect(text[1]).toContain('29 Sept 2026');  // 29/09/2026 is the 29th of September
  expect(text[3]).toContain('03-10-2026');
  expect(text[3]).toContain('Date is not YYYY-MM-DD or DD/MM/YYYY');
  expect(text[4]).toContain('Date is not YYYY-MM-DD or DD/MM/YYYY');  // 31 February
  expect(text[5]).toContain('Energy must be one number, with a dot for decimals');
  expect(text[6]).toContain('Energy must be one number, with a dot for decimals');
  expect(text[8]).toContain('Date appears twice');
  expect(text[9]).toContain('Date is in the future');
  await expect(page.locator('#import-go')).toHaveText('Save readings (4)');
  expect(await timeline(request, id), 'checking saves nothing').toHaveLength(0);
  // Changing the text takes the checked lines away: what is shown must be what will be saved.
  await page.locator('#import-text').press('End');
  await page.locator('#import-text').pressSequentially(' ');
  await expect(page.locator('#import-out')).toBeHidden();
});

test('import: lines are saved one at a time, oldest first, with progress, and the audit has them', async ({ page, request }) => {
  const id = await newPlant(request);
  await openImport(page, id);
  const rows = csvRows().slice(0, 12);
  // Written in the order they might come from a spreadsheet (newest first), in both formats.
  await paste(page, [...rows].reverse().map((r, i) => `${i % 2 ? dmy(r.date) : r.date},${r.kwh}`));
  await check(page);
  await expect(page.locator('#import-go')).toHaveText('Save readings (12)');
  let inFlight = 0, most = 0;
  const order = [];
  await page.route('**/api/sites/*/readings', async (route) => {
    inFlight += 1; most = Math.max(most, inFlight);
    order.push(route.request().postDataJSON().date);
    await new Promise((r) => setTimeout(r, 40));
    const res = await route.fetch();
    inFlight -= 1;
    await route.fulfill({ response: res });
  });
  await page.locator('#import-go').click();
  await expect(page.locator('#import-bar')).toBeVisible();  // progress while it runs
  await expect(page.locator('#import-sum')).toHaveText('Readings saved: 12 of 12.');
  await expect(page.locator('#import-bar')).toBeHidden();
  await expect(page.locator('#status')).toContainText('Readings saved: 12 of 12.');
  expect(most, 'never two saves at once').toBe(1);
  expect(order, 'oldest day first').toEqual(rows.map((r) => r.date));
  expect((await timeline(request, id)).map((p) => p.date)).toEqual(rows.map((r) => r.date));
  for (const text of await rowsOf(page).allInnerTexts()) expect(text).toContain('Saved');
  await expect(page.locator('#import-go')).toBeHidden();  // nothing is left to save
  // The plant's own screens follow: the reading count and the timeline are the new ones.
  await page.getByRole('tab', { name: 'Why' }).click();
  await expect(page.locator('#chart path.bar')).toHaveCount(12);
});

test('import: a refused line is reported and the rest are saved; pressing the button again sends only what is left', async ({ page, request }) => {
  const id = await newPlant(request);
  await openImport(page, id);
  const rows = csvRows().slice(0, 5);
  await paste(page, rows.map((r) => `${r.date},${r.kwh}`));
  await check(page);
  let refuse = true;
  const sent = [];
  await page.route('**/api/sites/*/readings', async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body.date);
    if (refuse && body.date === rows[2].date) { refuse = false; return route.fulfill({ status: 422, json: { detail: 'The energy looks too high for this plant.' } }); }
    return route.continue();
  });
  await page.locator('#import-go').click();
  await expect(page.locator('#import-sum')).toHaveText('Readings saved: 4 of 5.');
  const text = await rowsOf(page).allInnerTexts();
  expect(text[2]).toContain('The energy looks too high for this plant.');
  expect(text.filter((t) => t.includes('Saved'))).toHaveLength(4);
  await expect(page.locator('#import-go')).toHaveText('Save readings (1)');
  expect(await timeline(request, id)).toHaveLength(4);
  await page.locator('#import-go').click();
  await expect(page.locator('#import-sum')).toHaveText('Readings saved: 1 of 1.');
  expect(sent.slice(5), 'only the refused line is sent again').toEqual([rows[2].date]);
  expect(await timeline(request, id)).toHaveLength(5);
  await expect(page.locator('#import-go')).toBeHidden();
});

test('import: Stop leaves the rest unsaved and ready; no answer from the server stops the run and says so', async ({ page, request }) => {
  const id = await newPlant(request);
  await openImport(page, id);
  const rows = csvRows().slice(0, 6);
  await paste(page, rows.map((r) => `${r.date},${r.kwh}`));
  await check(page);
  let n = 0;
  await page.route('**/api/sites/*/readings', async (route) => {
    n += 1;
    if (n === 2) await page.locator('#import-stop').click();  // pressed while the second save is on its way
    if (n === 4) return route.abort('connectionrefused');
    return route.continue();
  });
  await page.locator('#import-go').click();
  await expect(page.locator('#import-sum')).toHaveText('Readings saved: 2 of 6.');
  await expect(page.locator('#import-go')).toHaveText('Save readings (4)');
  expect(await timeline(request, id)).toHaveLength(2);
  // Again, and now the connection drops on the second line of what is left: the run stops there, with the connection message.
  n = 2;
  await page.locator('#import-go').click();
  await expect(page.locator('#import-sum')).toHaveText('Readings saved: 1 of 4.');
  expect((await rowsOf(page).allInnerTexts()).join('\n')).toContain('Could not reach Surya Audit. Check your connection and try again.');
  expect(await timeline(request, id)).toHaveLength(3);
});

test('import: days that already have a reading are asked about once; No saves nothing, Yes replaces them', async ({ page, request }) => {
  const id = await newPlant(request, 5);
  await openImport(page, id);
  const rows = csvRows();
  await paste(page, [`${rows[1].date},9.9`, `${dmy(rows[2].date)},8.8`, `${rows[20].date},7.7`]);
  await check(page);
  const statuses = await rowsOf(page).evaluateAll((lis) => lis.map((li) => li.lastChild.textContent));
  expect(statuses).toEqual(['Ready', 'Ready', 'Ready']);  // the one question before saving covers the replaced days
  const sent = [];
  await page.route('**/api/sites/*/readings', (route) => { sent.push(route.request().postDataJSON().date); return route.continue(); });
  const questions = [];
  page.on('dialog', (d) => { questions.push(d.message()); return questions.length === 1 ? d.dismiss() : d.accept(); });
  await page.locator('#import-go').click();
  await expect.poll(() => questions.length).toBe(1);
  expect(questions[0]).toBe('Days that already have a reading: 2. Replace them?');
  expect(sent, 'No: nothing is sent').toEqual([]);
  expect(await timeline(request, id)).toHaveLength(5);
  await page.locator('#import-go').click();
  await expect(page.locator('#import-sum')).toHaveText('Readings saved: 3 of 3.');
  expect(questions).toHaveLength(2);  // one question each time, not one per day
  const after = await timeline(request, id);
  expect(after).toHaveLength(6);
  expect(after.find((p) => p.date === rows[1].date).kwh).toBe(9.9);
  expect(after.find((p) => p.date === rows[2].date).kwh).toBe(8.8);
});

test('import: a CSV file (with a byte-order mark) fills the box and is checked; 366 lines are accepted and 367 refused', async ({ page, request }) => {
  const id = await newPlant(request);
  await openImport(page, id);
  const rows = csvRows().slice(0, 3);
  const csv = String.fromCharCode(0xFEFF) + 'date,kwh\r\n' + rows.map((r) => `${r.date},${r.kwh}`).join('\r\n') + '\r\n';
  await page.locator('#import-file').setInputFiles({ name: 'history.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });
  // The browser drops the byte-order mark when it reads the file as text, and a textarea keeps line feeds only.
  await expect(page.locator('#import-text')).toHaveValue(csv.slice(1).replace(/\r\n/g, '\n'));
  await expect(page.locator('#import-sum')).toHaveText('3 ready to save, 0 to fix. Lines with a problem are not saved.');
  // The cap: a year of days is fine, one more is not (and nothing is checked line by line).
  const day = (n) => { const d = new Date('2026-10-09T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const year = Array.from({ length: 366 }, (_, n) => `${day(n)},5.0`);
  await paste(page, year);
  await check(page);
  await expect(page.locator('#import-sum')).toHaveText('366 ready to save, 0 to fix. Lines with a problem are not saved.');
  await expect(page.locator('#import-go')).toHaveText('Save readings (366)');
  await paste(page, [...year, `${day(366)},5.0`]);
  await check(page);
  await expect(page.locator('#import-sum')).toHaveText('More than 366 lines. Split them and add them in parts.');
  await expect(page.locator('#import-go')).toBeHidden();
  await expect(rowsOf(page)).toHaveCount(0);
});

test('import in Hindi: the checked lines, the results and the questions are in Hindi', async ({ page, request }) => {
  const id = await newPlant(request);
  await openImport(page, id, 'hi');
  const rows = csvRows().slice(0, 2);
  await paste(page, [`${rows[0].date},${rows[0].kwh}`, '03-10-2026,5.9']);
  await check(page);
  await expect(page.locator('#import-sum')).toHaveText('1 सेव के लिए तैयार, 1 ठीक करनी हैं। जिन पंक्तियों में समस्या है वे सेव नहीं होंगी।');
  const statuses = await rowsOf(page).evaluateAll((lis) => lis.map((li) => li.lastChild.textContent));
  expect(statuses).toEqual(['तैयार', 'तारीख़ YYYY-MM-DD या DD/MM/YYYY में नहीं है']);
  await page.locator('#import-go').click();
  await expect(page.locator('#import-sum')).toHaveText('सेव हुई रीडिंग: 1 में से 1।');
  // A language change takes the checked lines away: they must not stay in the old language.
  await paste(page, [`${rows[1].date},${rows[1].kwh}`]);
  await check(page);
  await expect(page.locator('#import-out')).toBeVisible();
  await page.getByRole('button', { name: 'EN: English' }).click();
  await expect(page.locator('#import-out')).toBeHidden();
});

test('import on a phone: no sideways scroll with a long list; the box and the buttons are reachable above the tab bar', async ({ page, request }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = await newPlant(request);
  await openImport(page, id);
  const day = (n) => { const d = new Date('2026-10-09T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  await paste(page, [...Array.from({ length: 40 }, (_, n) => `${day(n)},5.0`), 'a very long line that is not a date, not a number and keeps going to test that wrapping works at 375 px wide']);
  await check(page);
  await expect(rowsOf(page)).toHaveCount(41);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const barTop = (await page.locator('#tablist').boundingBox()).y;
  for (const sel of ['#import-check', '#import-go']) {
    await page.locator(sel).scrollIntoViewIfNeeded();
    const box = await page.locator(sel).boundingBox();
    expect(box.y + box.height, `${sel} is above the tab bar`).toBeLessThanOrEqual(barTop);
  }
  // The list scrolls inside itself and can be reached with the keyboard.
  const list = page.locator('#import-list');
  expect(await list.evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);
  await list.focus();
  await expect(list).toBeFocused();
});
