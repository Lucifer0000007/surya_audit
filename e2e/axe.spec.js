// Accessibility: axe-core (a pinned dev dependency, 4.13.0, see package.json) on every tab at 375 and 1280 px, in light and dark, in
// English, Hindi and Punjabi. Any violation fails the test. Runs against the offline API on a synthetic plant.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AXE = fs.readFileSync(path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf-8');
const TABS = ['today', 'log', 'fix', 'why', 'report'];

async function syntheticPlant(request) {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of lines) {
    const [date, kwh, kind] = line.split(',');
    expect((await request.post(`/api/sites/${id}/readings`, { data: { date, kwh: Number(kwh), kind: kind || 'daily' } })).ok()).toBeTruthy();
  }
  return id;
}

test('axe-core finds no violation on any tab, at 375 and 1280 px, light and dark, in English, Hindi and Punjabi', async ({ browser, request, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the checks set their own viewports');
  test.setTimeout(480_000);
  const id = await syntheticPlant(request);
  const found = [];
  let states = 0;
  for (const width of [375, 1280]) for (const scheme of ['light', 'dark']) for (const lang of ['en', 'hi', 'pa']) {
    const ctx = await browser.newContext({ baseURL, viewport: { width, height: 800 }, colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.evaluate((l) => localStorage.setItem('surya-audit-lang', l), lang);
    for (const tab of TABS) {
      await page.goto(`/?site=${id}&a=${width}${scheme}${lang}${tab}#${tab}`);
      await expect(page.locator(`#panel-${tab}`)).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);  // the language state first
      if (tab === 'why') await expect(page.locator('#chart svg')).toBeVisible();
      if (tab === 'report') { await page.locator('#draft-btn').click(); await expect(page.locator('#draft-out')).toBeVisible(); }
      await page.evaluate(AXE);  // an evaluation is not subject to the page's CSP
      const result = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] }));
      states += 1;
      for (const v of result.violations) found.push(`${tab}/${width}/${scheme}/${lang}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    }
    await ctx.close();
  }
  expect(states).toBe(60);
  expect(found).toEqual([]);
});
