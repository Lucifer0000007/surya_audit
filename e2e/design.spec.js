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
