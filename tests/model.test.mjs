// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  indexDrivers, computeStats, openAt, buildSeries, isStale,
  filterBugs, channels, gpus, escapeHtml, validateDatabase, compareVersions,
  selectSeries, rangeLabel, fixRate, possiblyFixedCount, listedAt,
  RANGE_ALL, RANGE_RECENT, RANGE_WORST, RANGE_LIMIT, POSSIBLY_FIXED,
} from '../lib/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = JSON.parse(readFileSync(join(ROOT, 'data/tracker.json'), 'utf8'));

const DRIVERS = [
  { version: '26.9.2', date: '2026-09-29', channel: 'Optional' },
  { version: '26.8.1', date: '2026-08-20', channel: 'Adrenalin' },
  { version: '26.1.1', date: '2026-01-21', channel: 'Adrenalin' },
];

test('indexDrivers sorts newest first regardless of file order', () => {
  const { sorted, order } = indexDrivers([...DRIVERS].reverse());
  assert.deepEqual(sorted.map((d) => d.version), ['26.9.2', '26.8.1', '26.1.1']);
  assert.equal(order.get('26.9.2'), 0, 'newest has the lowest index');
  assert.equal(order.get('26.1.1'), 2, 'oldest has the highest index');
});

test('computeStats splits fixed from pending', () => {
  const stats = computeStats(DRIVERS, [
    { status: 'fixed' }, { status: 'fixed' }, { status: 'pending' },
  ]);
  assert.deepEqual(stats, { drivers: 3, bugs: 3, fixed: 2, pending: 1 });
});

test('openAt is inclusive of the release that introduced the issue', () => {
  const { order } = indexDrivers(DRIVERS);
  const fixedInSameRelease = { first: '26.9.2', fixed_in: '26.9.2', status: 'fixed' };
  assert.equal(openAt(fixedInSameRelease, '26.9.2', order), false,
    'an issue fixed in its own release is not open there');
  assert.equal(openAt(fixedInSameRelease, '26.8.1', order), false,
    'and it did not exist yet in an older release');
});

test('openAt keeps an issue open across later releases until it is fixed', () => {
  const { order } = indexDrivers(DRIVERS);
  const carried = { first: '26.8.1', fixed_in: '26.9.2', status: 'fixed' };
  assert.equal(openAt(carried, '26.8.1', order), true, 'open in the release it appeared');
  assert.equal(openAt(carried, '26.9.2', order), false, 'closed in the release that fixed it');
});

test('openAt treats a pending issue as open in every later release', () => {
  const { order } = indexDrivers(DRIVERS);
  const pending = { first: '26.1.1', fixed_in: null, status: 'pending' };
  for (const v of ['26.1.1', '26.8.1', '26.9.2']) {
    assert.equal(openAt(pending, v, order), true, `expected open at ${v}`);
  }
});

test('buildSeries exposes persistence that bucketing by first would hide', () => {
  const series = buildSeries(DRIVERS, [
    { first: '26.1.1', fixed_in: null, status: 'pending' },
    { first: '26.9.2', fixed_in: '26.9.2', status: 'fixed' },
  ]);
  const oldest = series.find((s) => s.version === '26.1.1');
  const newest = series.find((s) => s.version === '26.9.2');
  assert.equal(oldest.introduced, 1);
  assert.equal(newest.introduced, 1);
  assert.equal(newest.fixedHere, 1);
  assert.equal(newest.open, 1, 'the old pending issue is still open in the newest release');
  assert.equal(newest.carried, 0, 'it was not introduced in the newest release');
});

test('carried is never negative when a release only fixes older issues', () => {
  const series = buildSeries(DRIVERS, [
    { first: '26.1.1', fixed_in: '26.9.2', status: 'fixed' },
  ]);
  const newest = series.find((s) => s.version === '26.9.2');
  assert.equal(newest.introduced, 0);
  assert.equal(newest.open, 0);
  assert.ok(newest.carried >= 0);
});

test('isStale flags a pending issue missing from the newest notes', () => {
  const { order } = indexDrivers(DRIVERS);
  assert.equal(isStale({ status: 'pending', last_seen: '26.1.1' }, '26.9.2', order), true);
  assert.equal(isStale({ status: 'pending', last_seen: '26.9.2' }, '26.9.2', order), false);
  assert.equal(isStale({ status: 'fixed', last_seen: '26.1.1' }, '26.9.2', order), false,
    'a fixed issue is not stale, it is done');
});

test('filterBugs matches across id, game, gpu and driver', () => {
  const bugs = DB.bugs;
  assert.ok(filterBugs(bugs, { query: 'AMD-0012' }, DB.drivers).length === 1);
  assert.ok(filterBugs(bugs, { query: 'starfield' }, DB.drivers).length >= 1);
  assert.ok(filterBugs(bugs, { query: 'RX 9060 XT' }, DB.drivers).length >= 1);
  assert.equal(filterBugs(bugs, { query: 'zzzz-no-match' }, DB.drivers).length, 0);
});

test('filterBugs by status is exclusive', () => {
  const pending = filterBugs(DB.bugs, { status: 'pending' }, DB.drivers);
  const fixed = filterBugs(DB.bugs, { status: 'fixed' }, DB.drivers);
  assert.equal(pending.length + fixed.length, DB.bugs.length);
  assert.ok(pending.every((b) => b.status === 'pending'));
  assert.ok(fixed.every((b) => b.status === 'fixed'));
});

test('filterBugs by driver finds issues touched by that release', () => {
  const rows = filterBugs(DB.bugs, { driver: '26.9.2' }, DB.drivers);
  assert.ok(rows.length > 0);
  for (const b of rows) {
    assert.ok(b.first === '26.9.2' || b.fixed_in === '26.9.2'
      || (b.sources || []).includes('26.9.2'), `${b.id} does not touch 26.9.2`);
  }
});

test('filterBugs by channel uses the driver channel', () => {
  const rows = filterBugs(DB.bugs, { channel: 'Optional' }, DB.drivers);
  assert.ok(rows.length > 0);
  const optional = new Set(DB.drivers.filter((d) => d.channel === 'Optional').map((d) => d.version));
  for (const b of rows) {
    assert.ok((b.sources || []).some((v) => optional.has(v)), `${b.id} is not an Optional issue`);
  }
});

test('filterBugs sorts newest first by default', () => {
  const { order } = indexDrivers(DB.drivers);
  const rows = filterBugs(DB.bugs, {}, DB.drivers);
  for (let i = 1; i < rows.length; i += 1) {
    const prev = order.get(rows[i - 1].first);
    const cur = order.get(rows[i].first);
    assert.ok(prev <= cur, 'rows should be ordered from newest release to oldest');
  }
});

test('channels and gpus exclude placeholders', () => {
  assert.deepEqual(channels(DB.drivers).sort(), ['Adrenalin', 'Optional']);
  assert.ok(!gpus(DB.bugs).includes('Not specified'));
  assert.ok(gpus(DB.bugs).length > 0);
});

test('escapeHtml neutralises markup in issue text', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml("it's \"quoted\" & done"), 'it&#39;s &quot;quoted&quot; &amp; done');
  assert.equal(escapeHtml(null), '');
});

test('validateDatabase accepts the shipped data', () => {
  assert.deepEqual(validateDatabase(DB), []);
});

test('validateDatabase rejects duplicate ids and unknown versions', () => {
  const dup = { drivers: DRIVERS, bugs: [{ id: 'AMD-0001' }, { id: 'AMD-0001' }] };
  assert.ok(validateDatabase(dup).some((p) => p.includes('duplicate id')));

  const bad = { drivers: DRIVERS, bugs: [{ id: 'AMD-0001', first: '99.9.9' }] };
  assert.ok(validateDatabase(bad).some((p) => p.includes('unknown first')));
});

test('every shipped issue has a source trail back to a tracked driver', () => {
  const versions = new Set(DB.drivers.map((d) => d.version));
  for (const b of DB.bugs) {
    assert.ok(Array.isArray(b.sources) && b.sources.length, `${b.id} has no sources`);
    for (const s of b.sources) {
      assert.ok(versions.has(s), `${b.id} cites untracked version ${s}`);
    }
  }
});

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions('26.9.2', '26.9.1') > 0);
  assert.ok(compareVersions('26.1.1', '25.12.1') > 0);
  // "12" sorts before "9" as a string. This is the whole reason the helper exists.
  assert.ok(compareVersions('25.12.1', '25.9.1') > 0, '25.12.1 must beat 25.9.1');
  assert.equal(compareVersions('26.9.2', '26.9.2'), 0);
});

test('indexDrivers breaks month-precision date ties on the version', () => {
  // Releases before ~25.9.2 carry no release date in their notes, so their date is
  // derived from the version number and 22.1.1 / 22.1.2 both land on 2022-01-01.
  // Which of those is newer must not depend on the order they appear in the file.
  const tied = [
    { version: '22.1.1', date: '2022-01-01' },
    { version: '22.1.2', date: '2022-01-01' },
    { version: '22.2.1', date: '2022-02-01' },
  ];
  const expected = ['22.2.1', '22.1.2', '22.1.1'];
  assert.deepEqual(indexDrivers(tied).sorted.map((d) => d.version), expected);
  assert.deepEqual(indexDrivers([...tied].reverse()).sorted.map((d) => d.version), expected,
    'the result must not depend on file order');
});

test('the shipped database is ordered newest-first and cites real drivers', () => {
  const versions = DB.drivers.map((d) => d.version);
  assert.deepEqual(indexDrivers(DB.drivers).sorted.map((d) => d.version), versions,
    'tracker.json must already be newest-first');
});

test('selectSeries windows a long archive and never invents releases', () => {
  const series = Array.from({ length: 50 }, (_, i) => ({
    version: '26.' + (50 - i) + '.1', open: i, fixedHere: 0,
  }));
  assert.equal(selectSeries(series, RANGE_ALL).length, 50, 'all time shows everything');
  assert.equal(selectSeries(series, RANGE_RECENT).length, RANGE_LIMIT);
  assert.equal(selectSeries(series, RANGE_WORST).length, RANGE_LIMIT);
  assert.equal(selectSeries(series, RANGE_RECENT)[0].version, series[0].version,
    'recent keeps the newest end, since the input is newest-first');
});

test('selectSeries returns the worst releases in chronological order', () => {
  const series = [
    { version: '26.3.1', open: 1, fixedHere: 0 },
    { version: '26.2.1', open: 99, fixedHere: 0 },
    { version: '26.1.1', open: 5, fixedHere: 0 },
  ];
  assert.deepEqual(selectSeries(series, RANGE_WORST, 2).map((s) => s.version),
    ['26.2.1', '26.1.1'], 'the two worst, in the order they appeared');
});

test('a short archive is never windowed', () => {
  const series = [{ version: '26.1.1', open: 1, fixedHere: 0 }];
  assert.equal(selectSeries(series, RANGE_RECENT).length, 1);
  assert.equal(selectSeries(series, RANGE_WORST).length, 1);
});

test('fixRate is the share of issues AMD has documented as fixed', () => {
  assert.equal(fixRate([]), 0, 'no issues means no rate, not a divide by zero');
  assert.equal(fixRate([{ status: 'fixed' }, { status: 'pending' }]), 0.5);
  assert.equal(fixRate([{ status: 'fixed' }, { status: 'fixed' }]), 1);
});

test('rangeLabel describes each range', () => {
  assert.match(rangeLabel(RANGE_RECENT), /latest \d+ releases/);
  assert.match(rangeLabel(RANGE_WORST), /worst/);
  assert.match(rangeLabel(RANGE_ALL), /every tracked release/);
});

test('the shipped chart window is a fraction of the archive', () => {
  // Guards the reason this exists: if the archive is bigger than the window, the
  // default view must be a window rather than all 80 bars at once.
  const series = buildSeries(DB.drivers, DB.bugs);
  assert.ok(series.length > RANGE_LIMIT, `archive is only ${series.length} releases`);
  assert.equal(selectSeries(series, RANGE_RECENT).length, RANGE_LIMIT);
  assert.equal(selectSeries(series, RANGE_ALL).length, series.length);
});

const STALE_DRIVERS = [
  { version: '26.2.1', date: '2026-02-01', channel: 'Adrenalin' },
  { version: '26.1.1', date: '2026-01-01', channel: 'Adrenalin' },
];
const STALE_BUGS = [
  // Listed once, then never again, with no fix documented: possibly fixed.
  { id: 'A', text: 'ghost issue', status: 'pending', first: '26.1.1', last_seen: '26.1.1', sources: ['26.1.1'] },
  // Still listed in the newest release: genuinely open.
  { id: 'B', text: 'live issue', status: 'pending', first: '26.2.1', last_seen: '26.2.1', sources: ['26.2.1'] },
  // Documented as fixed: not possibly fixed, it is fixed.
  { id: 'C', text: 'solved issue', status: 'fixed', first: '26.1.1', last_seen: '26.2.1', fixed_in: '26.2.1', sources: ['26.1.1', '26.2.1'] },
];

test('possiblyFixedCount counts only issues that stopped being listed', () => {
  const { order } = indexDrivers(STALE_DRIVERS);
  assert.equal(possiblyFixedCount(STALE_BUGS, '26.2.1', order), 1);
});

test('the possibly-fixed filter selects exactly those issues', () => {
  const rows = filterBugs(STALE_BUGS, { status: POSSIBLY_FIXED }, STALE_DRIVERS);
  assert.deepEqual(rows.map((b) => b.id), ['A']);
});

test('possibly fixed never swallows an issue AMD documented as fixed', () => {
  const rows = filterBugs(STALE_BUGS, { status: POSSIBLY_FIXED }, STALE_DRIVERS);
  assert.ok(!rows.some((b) => b.status === 'fixed'),
    'a documented fix is not uncertain, so it must not appear here');
});

test('an empty archive yields no possibly-fixed issues rather than throwing', () => {
  assert.equal(possiblyFixedCount([], '26.2.1', new Map()), 0);
  assert.deepEqual(filterBugs([], { status: POSSIBLY_FIXED }, []), []);
});

test('the shipped possibly-fixed count is a large share of pending, not a rounding error', () => {
  // This is the finding that motivated the label: most "pending" issues are not
  // actually being tracked by AMD any more. If this ever inverts, the wording on
  // the page is wrong.
  const { order } = indexDrivers(DB.drivers);
  const newest = indexDrivers(DB.drivers).sorted[0].version;
  const contiguousFrom = DB.meta?.contiguous_from ?? null;
  const possibly = possiblyFixedCount(DB.bugs, newest, order, contiguousFrom);
  const pending = DB.bugs.filter((b) => b.status === 'pending').length;
  assert.ok(possibly > 0, 'no possibly-fixed issues at all — is contiguous_from set?');
  assert.ok(possibly / pending > 0.5,
    `only ${possibly} of ${pending} pending issues stopped being listed; the page says they mostly have`);
});

test('isStale leaves issues before the verified window unjudged', () => {
  const drivers = [
    { version: '26.2.1', date: '2026-02-01', channel: 'Adrenalin' },
    { version: '22.1.1', date: '2022-01-01', channel: 'Adrenalin' },
    { version: '20.1.1', date: '2020-01-01', channel: 'Adrenalin' },
  ];
  const { order } = indexDrivers(drivers);
  const inWindow = { status: 'pending', first: '22.1.1', last_seen: '22.1.1' };
  const archived = { status: 'pending', first: '20.1.1', last_seen: '20.1.1' };

  // With no floor, both look like they stopped being listed.
  assert.equal(isStale(inWindow, '26.2.1', order), true);
  assert.equal(isStale(archived, '26.2.1', order), true);

  // With a floor, the one last seen inside the incomplete Archive range is not judged:
  // it may have been relisted and fixed in a release the Archive never captured.
  assert.equal(isStale(inWindow, '26.2.1', order, '22.1.1'), true);
  assert.equal(isStale(archived, '26.2.1', order, '22.1.1'), false);
});

test('possiblyFixedCount respects the verified window', () => {
  const drivers = [
    { version: '26.2.1', date: '2026-02-01', channel: 'Adrenalin' },
    { version: '22.1.1', date: '2022-01-01', channel: 'Adrenalin' },
    { version: '20.1.1', date: '2020-01-01', channel: 'Adrenalin' },
  ];
  const bugs = [
    { status: 'pending', first: '22.1.1', last_seen: '22.1.1' },
    { status: 'pending', first: '20.1.1', last_seen: '20.1.1' },
  ];
  const { order } = indexDrivers(drivers);
  assert.equal(possiblyFixedCount(bugs, '26.2.1', order), 2, 'no floor means both count');
  assert.equal(possiblyFixedCount(bugs, '26.2.1', order, '22.1.1'), 1,
    'the Archive-era issue must be excluded');
});

test('the possibly-fixed filter honours the verified window too', () => {
  const drivers = [
    { version: '26.2.1', date: '2026-02-01', channel: 'Adrenalin' },
    { version: '22.1.1', date: '2022-01-01', channel: 'Adrenalin' },
    { version: '20.1.1', date: '2020-01-01', channel: 'Adrenalin' },
  ];
  const bugs = [
    { id: 'IN', status: 'pending', first: '22.1.1', last_seen: '22.1.1', sources: ['22.1.1'] },
    { id: 'OLD', status: 'pending', first: '20.1.1', last_seen: '20.1.1', sources: ['20.1.1'] },
  ];
  const rows = filterBugs(bugs, { status: POSSIBLY_FIXED, contiguousFrom: '22.1.1' }, drivers);
  assert.deepEqual(rows.map((b) => b.id), ['IN']);
});

test('listedAt reads the sources trail rather than last_seen', () => {
  const bug = { sources: ['22.1.1', '22.5.1', '23.2.1'] };
  assert.equal(listedAt(bug, '22.5.1'), true);
  assert.equal(listedAt(bug, '23.2.1'), true);
  assert.equal(listedAt(bug, '24.1.1'), false);
  assert.equal(listedAt({}, '22.1.1'), false, 'no sources means listed nowhere');
});

test('buildSeries splits the unfixed count into still listed and vanished', () => {
  // AMD lists A and B, then drops B while keeping A. At the second release the backlog is
  // A alone: B has vanished, so counting it as backlog is exactly the double-count the
  // split exists to remove.
  const drivers = [
    { version: '26.2.1', date: '2026-02-01', channel: 'Adrenalin' },
    { version: '26.1.1', date: '2026-01-01', channel: 'Adrenalin' },
  ];
  const bugs = [
    { id: 'A', status: 'pending', first: '26.1.1', last_seen: '26.2.1', fixed_in: null,
      sources: ['26.1.1', '26.2.1'] },
    { id: 'B', status: 'pending', first: '26.1.1', last_seen: '26.1.1', fixed_in: null,
      sources: ['26.1.1'] },
  ];
  const [newest] = buildSeries(drivers, bugs);
  assert.equal(newest.open, 2, 'both are unfixed');
  assert.equal(newest.listed, 1, 'only A is still listed');
  assert.equal(newest.vanished, 1, 'B has vanished');
  assert.equal(newest.listed + newest.vanished, newest.open);
});

test('the shipped backlog is the still-listed count, not every unfixed issue', () => {
  // The point of the split. If `listed` ever equals `open` the page is reporting the whole
  // unfixed pile as backlog again, and counting the vanished issues a second time.
  const series = buildSeries(DB.drivers, DB.bugs);
  const newest = series[0];
  assert.ok(newest.listed > 0, 'no backlog at all - is the sources trail empty?');
  assert.ok(newest.listed < newest.open / 2,
    `${newest.listed} of ${newest.open} unfixed are still listed; the backlog should be the minority`);
  for (const s of series) {
    assert.equal(s.listed + s.vanished, s.open, `${s.version}: listed + vanished != open`);
    assert.ok(s.listed <= s.open, `${s.version}: more listed than unfixed`);
  }
});

test('the three outcome counts partition the shipped archive', () => {
  // Documented fixes + still listed + possibly fixed must account for every issue, or one
  // of them is double-counting.
  const series = buildSeries(DB.drivers, DB.bugs);
  const newest = series[0];
  const { order } = indexDrivers(DB.drivers);
  const possibly = possiblyFixedCount(DB.bugs, newest.version, order,
    DB.meta?.contiguous_from ?? null);
  const fixed = DB.bugs.filter((b) => b.status === 'fixed').length;
  assert.equal(fixed + newest.listed + possibly, DB.bugs.length,
    `${fixed} fixed + ${newest.listed} listed + ${possibly} possibly = ${DB.bugs.length}?`);
});

test('still listed and possibly fixed are complementary at the newest release', () => {
  const series = buildSeries(DB.drivers, DB.bugs);
  const newest = series[0];
  const { order } = indexDrivers(DB.drivers);
  const possibly = possiblyFixedCount(DB.bugs, newest.version, order,
    DB.meta?.contiguous_from ?? null);
  const pending = DB.bugs.filter((b) => b.status === 'pending').length;
  assert.equal(newest.listed + possibly, pending);
});
