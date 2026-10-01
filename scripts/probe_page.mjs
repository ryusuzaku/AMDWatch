// Rendered-page smoke check. Drives the real page in headless Chromium and
// asserts what a reader would actually see, rather than what the source implies.
//
//   python -m http.server 8000 --directory . --bind 127.0.0.1
//   NODE_PATH=<playwright node_modules> node scripts/probe_page.mjs http://127.0.0.1:8000
//
// Exits non-zero on the first failed expectation. Screenshots land in
// scripts/.probe/ for eyeballing.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '.probe');
mkdirSync(OUT, { recursive: true });

const failures = [];
const notes = [];

function check(label, condition, detail = '') {
  if (condition) {
    notes.push(`  ok    ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const badRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => badRequests.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) badRequests.push(`${r.status()} ${r.url()}`); });

// ---------------------------------------------------------------- happy path
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#app:not([hidden])', { timeout: 5000 });

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
check('no failed requests', badRequests.length === 0, badRequests.join(' | '));
check('loading panel is hidden after boot', await page.locator('#boot-status').isHidden());

const stats = await page.locator('#stats .stat strong').allTextContents();
check('four stat tiles render', stats.length === 4, `got ${stats.length}`);
check('stat tiles are numeric', stats.every((s) => /^\d+$/.test(s.trim())), stats.join(','));

const expected = JSON.parse(
  await (await fetch(`${BASE}/data/tracker.json`)).text(),
);
const fixedCount = expected.bugs.filter((b) => b.status === 'fixed').length;
check('bugs logged matches the database', stats[1] === String(expected.bugs.length),
  `page ${stats[1]} vs file ${expected.bugs.length}`);
check('documented fixes matches the database', stats[2] === String(fixedCount),
  `page ${stats[2]} vs file ${fixedCount}`);
check('pending count matches the database',
  stats[3] === String(expected.bugs.length - fixedCount));

const bars = await page.locator('#chart .bar-wrap').count();
check('one bar group per driver release', bars === expected.drivers.length,
  `got ${bars}, expected ${expected.drivers.length}`);

const zeroBars = await page.locator('#chart .bar[data-zero="true"]').count();
const chartNote = (await page.locator('#chart-note').textContent()) ?? '';
check('chart explains its own semantics', chartNote.includes('still open'));
notes.push(`  info  ${zeroBars} zero-valued bar(s) drawn as a baseline tick`);

const cards = await page.locator('#bugs .bug').count();
check('every issue renders a card', cards === expected.bugs.length,
  `got ${cards}, expected ${expected.bugs.length}`);

const metaText = await page.locator('#bugs .bug').first().locator('.meta').textContent();
check('cards show first seen', metaText.includes('First seen'));
check('cards show last seen or a stale badge',
  metaText.includes('Last seen') || metaText.includes('Not listed since'));

const staleBadges = await page.locator('.pill.stale').count();
const contiguous = expected.meta?.contiguous === true;
if (contiguous) {
  notes.push(`  info  ${staleBadges} issue(s) flagged as no longer listed`);
} else {
  check('sparse coverage does not claim issues were dropped', staleBadges === 0,
    `${staleBadges} stale badge(s) shown while meta.contiguous is false`);
  check('the chart warns that coverage is incomplete',
    chartNote.includes('not yet contiguous'), chartNote.slice(0, 160));
  check('the coverage notice says the window is sampled',
    ((await page.locator('#coverage').textContent()) ?? '').includes('sampled'));
}

await page.screenshot({ path: join(OUT, 'full.png'), fullPage: true });
await page.locator('#chart').screenshot({ path: join(OUT, 'chart.png') });

// ------------------------------------------------------------------ filtering
await page.selectOption('#status', 'pending');
await page.waitForTimeout(120);
const pendingCards = await page.locator('#bugs .bug').count();
check('pending filter narrows the list', pendingCards > 0 && pendingCards < cards,
  `${pendingCards} of ${cards}`);
check('pending filter writes a shareable url', page.url().includes('status=pending'), page.url());
check('all visible rows are pending',
  (await page.locator('#bugs .pill.pending').count()) === pendingCards);

await page.fill('#search', 'AMD-0012');
await page.selectOption('#status', 'all');
await page.waitForTimeout(120);
const searched = await page.locator('#bugs .bug').count();
check('search by id finds exactly one issue', searched === 1, `got ${searched}`);

await page.selectOption('#status', 'pending');
await page.fill('#search', 'AMD-0012');
await page.waitForTimeout(120);
check('a fixed issue is excluded while filtering to pending',
  (await page.locator('#bugs .bug').count()) === 0);

await page.selectOption('#status', 'all');

await page.fill('#search', 'no-such-issue-xyz');
await page.waitForTimeout(120);
check('empty state is shown when nothing matches',
  await page.locator('#bugs .empty').isVisible());

await page.click('#clear-filters');
await page.waitForTimeout(120);
check('clear filters restores the full list',
  (await page.locator('#bugs .bug').count()) === cards);

// ---------------------------------------------------------------- deep links
await page.goto(`${BASE}/#AMD-0012`, { waitUntil: 'networkidle' });
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(200);
check('deep link narrows to the linked issue',
  (await page.locator('#bugs .bug').count()) === 1,
  `got ${await page.locator('#bugs .bug').count()}`);
check('deep-linked issue is present in the dom',
  await page.locator('#bugs #AMD-0012').count() === 1);

// ---------------------------------------------------------------- error state
const errorPage = await context.newPage();
await errorPage.route('**/data/tracker.json', (route) => route.fulfill({
  status: 500, contentType: 'text/plain', body: 'boom',
}));
await errorPage.goto(BASE, { waitUntil: 'domcontentloaded' });
await errorPage.waitForSelector('.error-panel', { timeout: 5000 });
const errorText = (await errorPage.locator('.error-panel').textContent()) ?? '';
check('a failed fetch shows an error panel', errorText.includes('Could not load'));
check('the error names the actual failure', errorText.includes('500'), errorText.slice(0, 120));
check('the tracker is not left blank', await errorPage.locator('#app').isHidden());
await errorPage.screenshot({ path: join(OUT, 'error.png') });

// ------------------------------------------------------------- corrupt data
const badPage = await context.newPage();
await badPage.route('**/data/tracker.json', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: '{"drivers":[],"bugs":[]}',
}));
await badPage.goto(BASE, { waitUntil: 'domcontentloaded' });
await badPage.waitForSelector('.error-panel', { timeout: 5000 });
const badText = (await badPage.locator('.error-panel').textContent()) ?? '';
check('invalid data is rejected, not rendered', badText.includes('validation'), badText.slice(0, 120));

// --------------------------------------------------------------------- mobile
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(BASE, { waitUntil: 'networkidle' });
await mobile.waitForSelector('#app:not([hidden])');
const overflow = await mobile.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow on a phone viewport', overflow <= 1, `${overflow}px overflow`);
await mobile.screenshot({ path: join(OUT, 'mobile.png'), fullPage: true });

await browser.close();

console.log(notes.join('\n'));
if (failures.length) {
  console.log(`\nFAILED (${failures.length})`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`\nall ${notes.filter((n) => n.includes('ok')).length} checks passed`);
