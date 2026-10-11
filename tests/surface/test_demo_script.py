"""Proves docs/DEMO_GUIDE.md still matches the app: the demo storyline, step by step, against the LOCAL app.

What it does: starts the app with the recorded weather fixtures, no Gemini key and a FIXED clock (2026-10-12, India), loads the demo scenario with the
existing scripts/load_demo.py (60 synthetic readings, 2026-08-05 to 2026-10-03), then drives Chromium (Playwright, from node_modules) through S2 to S8 of the
guide with a fixed browser clock and the photo reading (Gemini) mocked at the network layer. Every step asserts the text and numbers the guide quotes. If the app
or the guide change, a step fails and names the text that is missing.

It does not run by default (verify.sh runs `pytest`, and this needs Chromium and a few seconds). Run it with:

    RUN_DEMO_SCRIPT=1 uv run pytest tests/surface/test_demo_script.py -s          (Git Bash)
    $env:RUN_DEMO_SCRIPT="1"; uv run pytest tests/surface/test_demo_script.py -s  (PowerShell)

It never calls the live stack, Gemini or the internet: the weather is the recorded copy, and the photo answer is a fixed mock. Live numbers are NOT checked here;
they are listed as "RECHECK ON LIVE" in the guide and in docs/DEMO_VERIFY.md.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
FIXED_TODAY = "2026-10-12"  # the server's clock for this test (the guide uses explicit dates only)

pytestmark = pytest.mark.skipif(os.environ.get("RUN_DEMO_SCRIPT") != "1", reason="set RUN_DEMO_SCRIPT=1 to run the demo-guide check (needs Chromium)")

# The steps of docs/DEMO_GUIDE.md, as node code. `must(label, text, needle)` records a mismatch instead of stopping, so one run lists every divergence.
STEPS_JS = r"""
const { chromium } = require(process.env.PW_MODULE);
const BASE = process.env.BASE_URL, SITE = process.env.SITE;
const clean = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const results = [];
let current = null;
const step = async (id, fn) => {
  current = { id, problems: [] };
  try { await fn(); } catch (e) { current.problems.push('exception: ' + String(e.message).split('\n')[0]); }
  results.push({ id, ok: current.problems.length === 0, problems: current.problems });
};
const must = (label, haystack, needle) => {
  const flat = (x) => String(x).replace(/\s+/g, ' ').trim();  // the page puts each part on its own line; the guide quotes them as one line
  const h = flat(haystack).toLowerCase(), n = flat(needle).toLowerCase();
  if (!h.includes(n)) current.problems.push(`${label}: expected "${needle}" in "${flat(haystack).slice(0, 260)}"`);
};
const mustNot = (label, haystack, needle) => {
  if (String(haystack).replace(/\s+/g, ' ').toLowerCase().includes(needle.toLowerCase())) current.problems.push(`${label}: did not expect "${needle}"`);
};
const equal = (label, got, want) => { if (got !== want) current.problems.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'Asia/Kolkata', colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-12T10:00:00+05:30'));
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const text = async (sel) => clean(await page.locator(sel).first().innerText());
  const tab = async (name) => { await page.getByRole('tab', { name, exact: true }).click(); await page.waitForSelector(`#panel-${name.toLowerCase()}:not([hidden])`); await page.waitForTimeout(400); };

  await step('S2', async () => {
    await page.goto(`/?site=${SITE}`);
    await page.waitForSelector('#headline .ring');
    await page.waitForTimeout(700);
    equal('tabs', (await page.getByRole('tab').allInnerTexts()).join(','), 'Today,Log,Fix,Why,Report');
    const banners = await text('#banners');
    must('notice strip', banners, 'Synthetic data'); must('notice strip', banners, 'Sample values in use');
    const hero = await text('#hero');
    must('verdict', hero, 'Output is well below usual. Check the suggestions.');
    must('number', hero, '55%'); must('number', hero, 'of this plant’s usual output');
    must('reading', hero, '7.6 kWh that day, expected 15.1 kWh. A dip: below 85% of usual.');
    must('latest reading', hero, 'Latest reading · 3 Oct 2026');
    must('top cause', hero, 'Top possible cause: Sudden fault'); must('confidence', hero, 'high confidence');
    must('honesty line', hero, 'A possible cause, not a diagnosis.');
    const ev = await text('#evidence');
    must('evidence', ev, 'Actual weather known for 60 of 60 readings'); must('evidence', ev, 'learnt from 14 readings');
    must('evidence', ev, '60 readings (synthetic)'); must('evidence', ev, 'Every threshold is an unvalidated heuristic.');
    const foot = await text('#honesty');
    must('footer', foot, 'Possible causes with confidence levels, not a diagnosis. Every threshold is an unvalidated heuristic.');
  });

  await step('S3', async () => {
    await tab('Why');
    equal('bars drawn', await page.locator('#chart path.bar').count(), 60);
    equal('dips drawn', await page.locator('#chart path.bar.dip').count(), 5);
    must('legend', await text('#legend'), 'Dip (below 85%)'); must('legend', await text('#legend'), '85% line');
    const causes = await text('#causes');
    must('rank 1', causes, '1. Sudden fault high confidence');
    must('rank 1 reason', causes, 'Since 2026-09-29, 5 readings in a row are 45% below the steady 7 before them, and the first one already dropped 45%.');
    must('rank 2', causes, '2. Dust on the panels low confidence');
    must('rank 2 reason', causes, 'Output has slid about 3.5% per day over the last 14 readings');
    must('rank 3', causes, '3. Low since the start low confidence'); must('rank 4', causes, '4. Weather or normal variation low confidence');
    must('not a diagnosis', causes, 'These are possibilities, not a diagnosis.');
  });

  await step('S4', async () => {
    await tab('Fix');
    const fix = await text('#panel-fix');
    must('title', fix, 'Suggestions, not orders. Approving one records your decision; nothing is acted on without your approval.');
    must('first card', fix, 'Check the inverter Waiting for your approval'); must('first card', fix, 'Suggested on 30 Sept 2026 for: Sudden fault.');
    must('second card', fix, 'Clean the panels Waiting for your approval'); must('second card', fix, 'Earlier suggestion: the audit no longer points to this cause.');
    const card = page.getByTestId('action-check_inverter');
    equal('approve date (the last reading)', await card.locator('input[type=date]').inputValue(), '2026-10-03');
    await card.getByRole('button', { name: /Approve/ }).click();
    await page.waitForTimeout(1500);
    must('status line', await text('#status'), 'Approved: Check the inverter. The next readings will show whether output comes back.');
    const after = await text('#panel-fix');
    must('card now', after, 'Check the inverter Checking the next readings');
    must('0 of 3', after, '0 of 3 usable readings logged after 2026-10-03.');
    equal('second card still waits', await page.getByTestId('action-clean_panels').getByRole('button', { name: /Approve/ }).count(), 1);
  });

  await step('S5', async () => {
    await tab('Log');
    for (const [date, value, shown] of [['2026-10-04', '7.4', '4 Oct 2026'], ['2026-10-05', '7.6', '5 Oct 2026'], ['2026-10-06', '7.2', '6 Oct 2026']]) {
      await page.getByText('Other date', { exact: true }).click();
      await page.getByLabel('Date', { exact: true }).fill(date);
      must(`date shown for ${date}`, await text('#date-shown'), `Reading for ${shown}`);
      await page.getByLabel('Energy produced (kWh)').fill(value);
      await page.getByRole('button', { name: 'Save reading' }).click();
      await page.waitForFunction(() => /Saved/.test(document.querySelector('#status').textContent), null, { timeout: 15000 });
      await page.waitForTimeout(300);
      must(`saved ${date}`, await text('#status'), `Saved the reading for ${shown}.`);
      equal(`field cleared after ${date}`, await page.inputValue('#kwh-input'), '');
    }
  });

  await step('S5b', async () => {  // the photo read, Gemini mocked: it fills the form and saves nothing
    await page.route('**/extract', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidate: { date: '2026-10-07', kwh: 7.3, kind: 'daily', cumulative_meter_kwh: null, what_was_read: 'Inverter app: yield today' }, saved: false, confirm_required: true, synthetic: true, sample: true, heuristic: true }) }));
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
    await page.setInputFiles('#photo', { name: 'inverter.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await page.waitForFunction(() => document.querySelector('#kwh-input').value !== '', null, { timeout: 20000 });
    await page.waitForTimeout(400);
    must('photo note', await text('#photo-review'), 'Read from your photo: Inverter app: yield today. Check the values below and correct them before you save. Nothing is saved yet.');
    equal('kWh filled', await page.inputValue('#kwh-input'), '7.3');
    must('date filled', await text('#date-shown'), 'Reading for 7 Oct 2026');
    equal('period', await page.locator('input[name=kind]:checked').inputValue(), 'daily');
    await page.locator('#photo-clear').click();
    await page.waitForTimeout(300);
    equal('kWh cleared by Discard photo', await page.inputValue('#kwh-input'), '');
  });

  await step('S6', async () => {
    await tab('Fix');
    const fix = await text('#panel-fix');
    must('verdict', fix, 'Check the inverter Output did not come back (provisional)');
    must('numbers', fix, "The 3 readings after 2026-10-03 were still at 62% of this plant's usual output. Weather for 3 of those readings is not available yet, so this verdict may change.");
    must('steps', fix, 'Waiting Checking Did not come back');
    await tab('Today');
    const hero = await text('#hero');
    must('today number', hero, '60%'); must('today reading', hero, '7.2 kWh that day, expected 13.1 kWh.');
    must('today weather note', hero, 'Weather for this day is not available yet, so the expectation uses the monthly average.');
    must('today cause', hero, 'Top possible cause: Sudden fault'); must('today confidence', hero, 'medium confidence');
    const ev = await text('#evidence');
    must('evidence', ev, 'Actual weather known for 60 of 63 readings'); must('evidence', ev, '63 readings (synthetic)');
    await tab('Why');
    const causes = await text('#causes');
    must('rank 1', causes, '1. Sudden fault medium confidence'); must('rank 2', causes, '2. Weather or normal variation medium confidence');
    must('rank 1 reason', causes, 'Since 2026-09-29, 8 readings in a row are 44% below the steady 7 before them');
    equal('dips drawn', await page.locator('#chart path.bar.dip').count(), 8);
  });

  await step('S7', async () => {
    await tab('Report');
    const before = await text('#panel-report');
    must('no suggestion yet', before, 'Waiting for published weather before suggesting a complaint.');
    must('why', before, "check_inverter approved on 2026-10-03: The 3 readings after 2026-10-03 were still at 62% of this plant's usual output.");
    await page.locator('#draft-btn').click();
    await page.waitForSelector('#draft-out:not([hidden])');
    await page.waitForTimeout(400);
    const report = await text('#panel-report');
    must('nothing sent', report, 'Nothing has been sent. Replace every <<OWNER TO FILL>> before you file it.');
    must('categories', report, 'Suggested complaint categories: Poor equipment. SAMPLE: category names are unverified. Check the official MNRE procedure before filing.');
    const draft = await page.inputValue('#draft-text');
    must('draft banner', draft, 'SYNTHETIC DATA: this draft is built from synthetic readings and is not a real complaint.');
    must('draft sent line', draft, 'DRAFT: review, complete and file this yourself. Nothing has been sent.');
    must('placeholder', draft, '<<OWNER TO FILL: installer / vendor name and complaint channel>>');
    must('placeholder', draft, 'Panel and inverter serial numbers: <<OWNER TO FILL: serial numbers from the panels and inverter>>');
    must('numbers', draft, 'on 8 of 58 usable readings (first on 2026-09-29, last on 2026-10-06)');
    must('approval line', draft, "On 2026-10-03 I approved the suggestion 'check inverter'.");
    must('cause line', draft, 'sudden fault (medium confidence)');
    mustNot('no invented serial', draft, 'SN-');
  });

  await step('S8', async () => {
    await page.getByRole('button', { name: 'हिन्दी' }).click();
    await page.waitForTimeout(500);
    await page.locator('#tab-today').click();
    await page.waitForTimeout(500);
    equal('Hindi tabs', (await page.getByRole('tab').allInnerTexts()).join(','), 'आज,रीडिंग,उपाय,क्यों,शिकायत');
    const hero = await text('#hero');
    must('Hindi verdict', hero, 'उत्पादन सामान्य से काफ़ी कम है। सुझाव देखें।'); must('Hindi honesty line', hero, 'यह संभावित कारण है, निदान नहीं।');
    must('Hindi notice', await text('#banners'), 'नकली (synthetic) डेटा');
    equal('no Hindi voice in this browser, so no Read aloud', await page.locator('.speak').count(), 0);
    await page.locator('.lang button').first().click();
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
    await page.locator('#bigger').click();
    await page.waitForTimeout(300);
    equal('A+ pressed', await page.locator('#bigger').getAttribute('aria-pressed'), 'true');
    const after = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
    if (!(after > before)) current.problems.push(`A+ did not enlarge the text (${before} -> ${after})`);
  });

  await step('console', async () => { equal('page errors', JSON.stringify(pageErrors), '[]'); });
  console.log('RESULTS ' + JSON.stringify(results));
  await browser.close();
})().catch((e) => { console.log('HARNESS_FAILED ' + e.message); process.exit(1); });
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(port: int) -> subprocess.Popen:
    code = (
        "import os, sys; sys.path.insert(0, '.')\n"
        "os.environ['PVGIS_MODE'] = 'fixture'; os.environ['IRRADIANCE_MODE'] = 'fixture'\n"
        "[os.environ.pop(n, None) for n in ('GEMINI_API_KEY', 'GEMINI_KEY_PARAM', 'SITES_TABLE')]\n"
        "from datetime import date\nfrom app import clock\n"
        f"clock.today = lambda: date({FIXED_TODAY.replace('-', ', ').replace(', 0', ', ')})\n"
        f"import uvicorn\nuvicorn.run('app.main:app', host='127.0.0.1', port={port}, log_level='warning')\n"
    )
    proc = subprocess.Popen([sys.executable, "-c", code], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).read()
            return proc
        except OSError:
            time.sleep(0.5)
    proc.kill()
    raise RuntimeError("the local app did not start")


def test_the_demo_guide_matches_the_app(tmp_path):
    node = shutil.which("node")
    playwright = ROOT / "node_modules" / "@playwright" / "test"
    if not node or not playwright.exists():
        pytest.skip("node and @playwright/test (npm install) are needed")
    port = free_port()
    server = start_server(port)
    try:
        base = f"http://127.0.0.1:{port}"
        link = subprocess.run([sys.executable, "scripts/load_demo.py", base], cwd=ROOT, capture_output=True, text=True, timeout=120, check=True).stdout.strip()
        site = link.split("site=")[1]
        script = tmp_path / "demo_steps.js"
        script.write_text(STEPS_JS, encoding="utf-8")
        env = {**os.environ, "BASE_URL": base, "SITE": site, "PW_MODULE": str(playwright).replace("\\", "/")}
        run = subprocess.run([node, str(script)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=240)
    finally:
        server.kill()
    out = run.stdout
    assert "HARNESS_FAILED" not in out, out + run.stderr
    line = next((ln for ln in out.splitlines() if ln.startswith("RESULTS ")), None)
    assert line, out + run.stderr
    results = json.loads(line[len("RESULTS "):])
    for r in results:
        print(f"{r['id']:8} {'PASS' if r['ok'] else 'FAIL'}", *r["problems"], sep="\n    " if r["problems"] else " ")
    assert [r["id"] for r in results] == ["S2", "S3", "S4", "S5", "S5b", "S6", "S7", "S8", "console"]
    failed = [r for r in results if not r["ok"]]
    assert not failed, "the guide and the app diverge:\n" + "\n".join(f"{r['id']}: " + "; ".join(r["problems"]) for r in failed)
