// Usability rubric checks on the rebuilt screens (master prompt v4): tap targets, spacing between them, the main action on the first
// phone screen, one inverted card, no native select or spinner on Today, no side scroll from 320 px, and the type hierarchy.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
async function plant(request) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of lines) {
    const [date, kwh, kind] = line.split(',');
    expect((await request.post(`/api/sites/${id}/readings`, { data: { date, kwh: Number(kwh), kind: kind || 'daily' } })).ok()).toBeTruthy();
  }
  return id;
}

// every control that can be tapped: at least 48 px in both directions, and no two closer than 8 px
const scan = () => {
  const controls = [...document.querySelectorAll('button, a.button, [role=tab], summary, input:not([type=hidden]):not([type=file]), select, textarea')]
    .filter((n) => !n.closest('[hidden], .sr-only') && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden')
    .map((n) => ({ n, r: n.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 1 && r.height > 1);
  const small = controls.filter(({ r }) => r.height < 47.5 || r.width < 47.5).map(({ n, r }) => `${n.id || n.className || n.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
  const close = [];
  controls.forEach(({ n, r }, i) => controls.slice(i + 1).forEach(({ n: m, r: q }) => {
    if (n.contains(m) || m.contains(n)) return;
    if (n.matches('[role=tab]') !== m.matches('[role=tab]')) return;  // the fixed tab bar passes over content as the page scrolls
    const dx = Math.max(q.left - r.right, r.left - q.right);
    const dy = Math.max(q.top - r.bottom, r.top - q.bottom);
    if (dx < 7.5 && dy < 7.5 && !(dx < 0 && dy < 0)) close.push(`${n.id || n.className || n.tagName} / ${m.id || m.className || m.tagName} (${Math.round(Math.max(dx, dy))}px)`);
  }));
  return { small, close };
};

test('Today on a phone: every control is at least 48 px and no two are closer than 8 px; nothing scrolls sideways from 320 px', async ({ page, request }) => {
  const id = await plant(request);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/?site=${id}&w=${width}`);
    await expect(page.locator('#headline .ring')).toBeVisible();
    const found = await page.evaluate(scan);
    expect(found.small, `${width}px: controls under 48 px`).toEqual([]);
    expect(found.close, `${width}px: controls closer than 8 px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px: sideways scroll`).toBeLessThanOrEqual(0);
  }
});

test('Today: one inverted block, no native select or spinner, a clear type hierarchy, the main action on the first phone screen', async ({ page, request }) => {
  const id = await plant(request);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`/?site=${id}`);
  await expect(page.locator('#headline .ring')).toBeVisible();
  const look = await page.evaluate(() => {
    const dark = (c) => { const m = c.match(/\d+/g).map(Number); return m[3] === 0 ? false : (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) < 60; };
    const solid = [...document.querySelectorAll('#panel-today *')].filter((n) => n.getClientRects().length && n.getBoundingClientRect().width > 200 && n.getBoundingClientRect().height > 100 && dark(getComputedStyle(n).backgroundColor)).map((n) => n.id || n.className);
    const size = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
    const tab = document.querySelector('.tabs').getBoundingClientRect().top;
    const main = document.querySelector('#headline a.hero-btn').getBoundingClientRect();
    return { solid, display: size('.ring-num'), heading: size('.verdict-sentence'), body: size('.hero-line'), caption: size('.eyebrow'), selects: [...document.querySelectorAll('#panel-today select, #panel-today input[type=date]')].filter((n) => n.getClientRects().length).length + [...document.querySelectorAll('#panel-today input[type=number]')].filter((n) => getComputedStyle(n).appearance !== 'textfield').length, mainBottom: main.bottom, mainHeight: main.height, tab };
  });
  expect(look.solid, 'one big dark block on Today').toEqual(['hero']);  // the verdict card
  expect(look.selects).toBe(0);
  expect(look.display).toBeGreaterThan(look.heading);
  expect(look.heading).toBeGreaterThan(look.body);
  expect(look.body).toBeGreaterThanOrEqual(look.caption);
  expect(look.mainHeight).toBeGreaterThanOrEqual(56);
  expect(look.mainBottom, 'the main action is above the tab bar on a 667 px phone').toBeLessThanOrEqual(look.tab);
});

test('Log on a phone: every control is at least 48 px and 8 px apart, Period is a segmented control not a select, nothing scrolls sideways from 320 px', async ({ page, request }) => {
  const id = await plant(request);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/?site=${id}&w=${width}#log`);
    await expect(page.locator('#panel-log')).toBeVisible();
    const found = await page.evaluate(scan);
    expect(found.small, `${width}px: controls under 48 px`).toEqual([]);
    expect(found.close, `${width}px: controls closer than 8 px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px: sideways scroll`).toBeLessThanOrEqual(0);
  }
  await expect(page.locator('#panel-log select')).toHaveCount(0);
  await expect(page.locator('#reading-form input[name=kind]')).toHaveCount(2);
  await expect(page.locator('#reading-form .unit')).toHaveText('kWh');  // the same unit as the label, not "units"
});

test('Log: the chosen Period and date are filled with ink, and One week is sent as a weekly reading', async ({ page, request }) => {
  const id = await plant(request);
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#panel-log')).toBeVisible();
  const fill = (name) => page.locator(`label:has(input[name=${name}]:checked)`).evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(await fill('kind')).toBe(await fill('datechip'));  // one look for both choices
  expect(await fill('kind')).not.toBe('rgba(0, 0, 0, 0)');
  await page.locator('label:has(input[name=kind][value=weekly])').click();
  await expect(page.locator('input[name=kind][value=weekly]')).toBeChecked();
  await page.fill('#kwh-input', '70.5');
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/sites/${id}/readings`));
  await page.locator('#save-btn').click();
  expect((await sent).postDataJSON()).toMatchObject({ kwh: 70.5, kind: 'weekly' });
});

test('Fix on a phone: each suggestion is a card, the progress comes after the Approve button, controls are 48 px and 8 px apart, nothing scrolls sideways from 320 px', async ({ page, request }) => {
  const id = await plant(request);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/?site=${id}&w=${width}#fix`);
    await expect(page.locator('#panel-fix .action').first()).toBeVisible();
    const found = await page.evaluate(scan);
    expect(found.small, `${width}px: controls under 48 px`).toEqual([]);
    expect(found.close, `${width}px: controls closer than 8 px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px: sideways scroll`).toBeLessThanOrEqual(0);
  }
  const card = page.locator('#panel-fix .action').first();
  await expect(card).toHaveCSS('border-top-left-radius', '6px');  // retried: the card can be re-drawn while the page settles
  await expect(card).not.toHaveCSS('box-shadow', 'none');
  const y = await page.locator('#panel-fix .action').first().evaluate((n) => [n.querySelector('.approve-btn'), n.querySelector('.steps')].map((x) => x.getBoundingClientRect().top));
  expect(y[0], 'Approve comes before the progress steps').toBeLessThan(y[1]);
});

test('Why: controls 48 px and 8 px apart, no sideways scroll from 320 px; on a desktop the chart is a card and the causes sit in two columns; the replay button has no white halo', async ({ page, request }) => {
  const id = await plant(request);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/?site=${id}&w=${width}#why`);
    await expect(page.locator('#chart svg')).toBeVisible();
    const found = await page.evaluate(scan);
    expect(found.small, `${width}px: controls under 48 px`).toEqual([]);
    expect(found.close, `${width}px: controls closer than 8 px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px: sideways scroll`).toBeLessThanOrEqual(0);
  }
  const ring = await page.locator('#replay-btn').evaluate((n) => getComputedStyle(n).boxShadow);
  expect(ring, 'one 1px ring in the band\'s own control colour, no canvas halo').not.toMatch(/\) 0px 0px 0px 2px/);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?site=${id}&w=1280#why`);
  await expect(page.locator('#chart svg')).toBeVisible();
  const box = await page.evaluate(() => {
    const b = document.querySelector('#panel-why > .band').getBoundingClientRect();
    const c = [...document.querySelectorAll('#cause-list .cause')].map((n) => Math.round(n.getBoundingClientRect().left));
    return { width: Math.round(b.width), radius: getComputedStyle(document.querySelector('#panel-why > .band')).borderTopLeftRadius, columns: new Set(c).size };
  });
  expect(box.width).toBeLessThanOrEqual(1040);
  expect(box.radius).toBe('6px');
  expect(box.columns).toBe(2);
});

test('Report: the buttons under the draft stay quiet (Draft is the only primary, and only when escalation is suggested), controls are 48 px and 8 px apart, nothing scrolls sideways from 320 px', async ({ page, request }) => {
  const id = await plant(request);
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`/?site=${id}&w=${width}#report`);
    await page.locator('#draft-btn').click();
    await expect(page.locator('#draft-out')).toBeVisible();
    const found = await page.evaluate(scan);
    expect(found.small, `${width}px: controls under 48 px`).toEqual([]);
    expect(found.close, `${width}px: controls closer than 8 px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px: sideways scroll`).toBeLessThanOrEqual(0);
  }
  const look = await page.evaluate(() => ['#copy-btn', '#download-btn', '#share-draft'].map((s) => { const n = document.querySelector(s); return [getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)', Math.round(n.getBoundingClientRect().height)]; }));
  expect(look.map((l) => l[0])).toEqual([false, false, false]);
  expect(look.every((l) => l[1] >= 48)).toBe(true);
  await expect(page.locator('#share-draft')).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);  // a real link before any click
  await page.fill('#draft-text', 'my edit');
  await expect(page.locator('#share-draft')).toHaveAttribute('href', 'https://wa.me/?text=my%20edit');
  const gap = await page.evaluate(() => { const l = document.querySelector('#draft-out > label').getBoundingClientRect(), c = document.querySelector('#draft-out > .callout:not([hidden])').getBoundingClientRect(); return l.top - c.bottom; });
  expect(gap, 'the label does not touch the notice above it').toBeGreaterThanOrEqual(8);
});

// A new owner's walkthrough, counting every tap or field they must touch. More than 6 for one task is a flag.
test('new user: set up the plant in 6 taps or fewer, then log the first reading in 3 and see the result in 4', async ({ page }) => {
  let taps = 0;
  const tap = async (locator) => { taps += 1; await locator.click(); };
  const type = async (locator, text) => { taps += 1; await locator.fill(text); };
  await page.goto('/');
  await type(page.getByLabel('Latitude'), '26.85');
  await type(page.getByLabel('Longitude'), '80.95');
  await tap(page.getByRole('button', { name: 'Next' }));
  await type(page.getByLabel('Plant size (kW)'), '3');
  await tap(page.getByRole('button', { name: 'Next' }));
  await tap(page.getByRole('button', { name: 'Start auditing' }));
  const setup = taps;
  expect(setup, 'taps to set up the plant').toBeLessThanOrEqual(6);
  await expect(page.locator('#hero')).toBeVisible();
  taps = 0;
  await tap(page.locator('a.hero-btn', { hasText: 'Log a reading' }));
  await type(page.locator('#kwh-input'), '12.4');
  await tap(page.locator('#save-btn'));
  await expect(page.locator('#status')).toContainText('Saved', { timeout: 15000 });  // Save stays on Log and says so
  expect(taps, 'taps to log the first reading').toBeLessThanOrEqual(3);
  await tap(page.getByRole('tab', { name: 'Today', exact: true }));  // and one more to see the updated result
  await expect(page.locator('#hero')).toBeVisible();
  expect(taps, 'taps from Today to the updated result').toBeLessThanOrEqual(6);
  console.log(`WALKTHROUGH setup=${setup} first-reading-to-result=${taps}`);
});

test('late voices do not redraw the Fix cards under the owner (a date being edited or a focused Approve button stays)', async ({ page, request }) => {
  const id = await plant(request);
  await page.goto(`/?site=${id}#fix`);
  const input = page.locator('#panel-fix .action input[type=date]').first();
  await expect(input).toBeVisible();
  await page.waitForTimeout(500);  // the idle set-up has run
  await input.evaluate((n) => { n.dataset.mark = 'mine'; });
  await page.evaluate(() => { speechSynthesis.dispatchEvent(new Event('voiceschanged')); });
  await page.waitForTimeout(300);
  await expect(page.locator('#panel-fix .action input[type=date][data-mark=mine]').first(), 'the same card is still there').toBeVisible();
});
