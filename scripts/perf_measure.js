// Performance numbers for the Surya Audit page: Playwright through CDP with a throttled network and CPU, against a LOCAL server
// (scripts/verify.sh style: PVGIS_MODE=fixture IRRADIANCE_MODE=fixture, no Gemini key). Usage:
//   BASE_URL=http://127.0.0.1:8123 node scripts/perf_measure.js [runs]
// Profiles (assumptions from master prompt v4, not measured networks):
//   A = 2 Mbps down, 1 Mbps up, 150 ms latency, 4x CPU slowdown; B = 5 Mbps down, 2 Mbps up, 80 ms latency;
//   C = slow 3G (500 kbps down and up, 400 ms latency, 4x CPU), informational.
// Every API call is delayed by SERVER_DELAY_MS before it is sent, to stand in for Lambda time (an assumption, not a measurement).
// What is measured, per run, on a cold cache and a fresh browser context:
//   fcp, lcp, cls, tbt (sum of long-task time over 50 ms after first paint), tabsRespond (DOMContentLoaded event end: the script that
//   wires the tabs has run), auditDrawn (first time the headline ring exists after the audit call), tabSwitchLong (longest long task
//   during a tab switch), and the bytes of the page as transferred and decoded.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL;
if (!BASE) throw new Error('Set BASE_URL to a running Surya Audit server');
const RUNS = Number(process.argv[2] || 3);
const SERVER_DELAY_MS = Number(process.env.SERVER_DELAY_MS || 100);
const ROOT = path.join(__dirname, '..');
const KB = 1024 / 8;  // bytes per second per kbit/s
const PROFILES = {
  A: { down: 2000, up: 1000, latency: 150, cpu: 4 },
  B: { down: 5000, up: 2000, latency: 80, cpu: 1 },
  C: { down: 500, up: 500, latency: 400, cpu: 4 },
};

async function makePlant() {
  const post = async (url, data) => {
    const res = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json();
  };
  const site = await post('/api/sites', JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')));
  const [, ...lines] = fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.csv'), 'utf-8').trim().split(/\r?\n/);
  for (const line of lines) {
    const [date, kwh, kind] = line.split(',');
    await post(`/api/sites/${site.id}/readings`, { date, kwh: Number(kwh), kind: kind || 'daily' });
  }
  return site.id;
}

async function once(browser, id, profile) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  if (process.env.LANG_PREF) await page.addInitScript((l) => localStorage.setItem('surya-audit-lang', l), process.env.LANG_PREF);  // hi or pa
  await page.addInitScript(() => {
    window.__perf = { fcp: null, lcp: null, cls: 0, longs: [], drawn: null, mark: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longs.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
    new MutationObserver(() => {
      if (window.__perf.drawn == null && document.querySelector('#headline .ring')) window.__perf.drawn = performance.now();
    }).observe(document, { subtree: true, childList: true });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.down * KB, uploadThroughput: profile.up * KB });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  await page.route('**/api/**', async (route) => { await new Promise((r) => setTimeout(r, SERVER_DELAY_MS)); await route.continue(); });
  let transferred = 0;
  cdp.on('Network.loadingFinished', (e) => { if (e.encodedDataLength > transferred && e.encodedDataLength > 50000) transferred = e.encodedDataLength; });
  await page.goto(`${BASE}/?site=${id}`, { waitUntil: 'load' });
  await page.waitForSelector('#headline .ring', { timeout: 60000 });
  await page.waitForTimeout(1500);  // let late paints and shifts land
  const fontsMs = await page.evaluate(async () => { const t0 = performance.now(); await document.fonts.ready; return performance.now() - t0 + t0; });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, decoded: n.decodedBodySize, encoded: n.encodedBodySize };
  });
  const base = await page.evaluate(() => ({ ...window.__perf }));
  const tbt = base.longs.filter(([start]) => base.fcp != null && start >= base.fcp).reduce((sum, [, dur]) => sum + Math.max(0, dur - 50), 0);
  // a tab switch: the longest long task while it happens, and how long until the new tab shows
  await page.evaluate(() => { window.__perf.mark = performance.now(); window.__perf.longs = []; });
  const t0 = Date.now();
  await page.locator('#tab-log').tap();
  await page.waitForFunction(() => document.getElementById('tab-log').getAttribute('aria-selected') === 'true' && !document.getElementById('panel-log').hidden);
  const switchMs = Date.now() - t0;
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__perf.longs.map(([, d]) => d));
  await ctx.close();
  return { fcp: base.fcp, lcp: base.lcp, cls: base.cls, tbt, tabsRespond: nav.dcl, auditDrawn: base.drawn, tabSwitchMs: switchMs, tabSwitchLong: after.length ? Math.max(...after) : 0, fontsReady: fontsMs, load: nav.load, encoded: nav.encoded, decoded: nav.decoded };
}

const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

(async () => {
  const id = await makePlant();
  const browser = await chromium.launch();
  const out = {};
  const only = (process.env.PROFILES || '').split(',').filter(Boolean);
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (only.length && !only.includes(name)) continue;
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await once(browser, id, profile));
    out[name] = {};
    for (const k of Object.keys(runs[0])) out[name][k] = median(runs.map((r) => r[k]));
    out[name].runs = RUNS;
  }
  await browser.close();
  const rounded = JSON.parse(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  console.log(JSON.stringify({ serverDelayMs: SERVER_DELAY_MS, profiles: PROFILES, medians: rounded }, null, 1));
})();
