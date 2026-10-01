// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  indexDrivers, computeStats, openAt, buildSeries, isStale,
  filterBugs, channels, gpus, escapeHtml, validateDatabase, compareVersions,
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
