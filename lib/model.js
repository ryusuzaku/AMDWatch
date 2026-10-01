// Pure data logic for AMDWatch. No DOM, no fetch, no globals: this module is
// imported by app.js in the browser and by tests/model.test.mjs under Node.

export const NEWEST_FIRST = 'newest';
export const OLDEST_FIRST = 'oldest';

// How many releases the chart shows at once. The archive is ~80 releases, which is
// unreadable as 80 bars, so the default window is the most recent handful.
export const RANGE_LIMIT = 20;
export const RANGE_RECENT = 'recent';
export const RANGE_WORST = 'worst';
export const RANGE_ALL = 'all';

// Issues that were listed in an earlier release and have stopped being listed without
// AMD ever documenting a fix. Two readings, and the release notes cannot tell them
// apart: AMD fixed it silently, or AMD simply stopped mentioning it. The tracker does
// not know which, so it reports the uncertainty rather than calling the issue open or
// fixed. Only meaningful when coverage is contiguous.
export const POSSIBLY_FIXED = 'possibly-fixed';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Version numbers sort correctly as numeric tuples: 26.9.2 > 26.9.1 > 25.12.1.
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Drivers are stored newest-first, but never trust the file order.
export function indexDrivers(drivers = []) {
  const sorted = [...drivers].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    // Older releases only carry a month-precision date, so ties are common.
    // Break them on the version tuple rather than on the caller's file order.
    return compareVersions(b.version, a.version);
  });
  const order = new Map();
  const byVersion = new Map();
  sorted.forEach((d, i) => {
    order.set(d.version, i);
    byVersion.set(d.version, d);
  });
  // `order` is indexed newest-first: a LOWER index means a NEWER release.
  return { sorted, order, byVersion };
}

export function computeStats(drivers = [], bugs = []) {
  const fixed = bugs.filter((b) => b.status === 'fixed').length;
  return {
    drivers: drivers.length,
    bugs: bugs.length,
    fixed,
    pending: bugs.length - fixed,
  };
}

// An issue is open at release R when it was introduced at or before R and is not
// yet documented as fixed at R. This is what makes persistent issues visible;
// bucketing by `first` alone hides them.
export function openAt(bug, version, order) {
  const idx = order.get(version);
  const first = order.get(bug.first);
  if (idx === undefined || first === undefined) return false;
  if (first < idx) return false; // introduced in a newer release than R
  if (!bug.fixed_in) return true;
  const fixed = order.get(bug.fixed_in);
  if (fixed === undefined) return true;
  return fixed < idx; // fixed in a newer release, so still open at R
}

export function buildSeries(drivers = [], bugs = []) {
  const { sorted, order } = indexDrivers(drivers);
  return sorted.map((driver) => {
    const idx = order.get(driver.version);
    const introduced = bugs.filter((b) => b.first === driver.version).length;
    const fixedHere = bugs.filter((b) => b.fixed_in === driver.version).length;
    const open = bugs.filter((b) => openAt(b, driver.version, order)).length;
    return {
      version: driver.version,
      date: driver.date,
      channel: driver.channel,
      url: driver.url,
      introduced,
      fixedHere,
      open,
      carried: Math.max(0, open - introduced),
    };
  });
}

// Which slice of releases the chart shows. `series` is newest-first.
//   recent - the newest RANGE_LIMIT releases, which is the useful default
//   worst  - the RANGE_LIMIT releases with the most open issues, returned in
//            chronological order so the chart still reads left-to-right in time
//   all    - everything
export function selectSeries(series = [], range = RANGE_ALL, limit = RANGE_LIMIT) {
  if (range === RANGE_ALL || series.length <= limit) return series;
  if (range === RANGE_WORST) {
    const picked = [...series]
      .sort((a, b) => (b.open - a.open) || (b.fixedHere - a.fixedHere))
      .slice(0, limit);
    const keep = new Set(picked.map((s) => s.version));
    return series.filter((s) => keep.has(s.version));
  }
  return series.slice(0, limit);
}

export function rangeLabel(range) {
  if (range === RANGE_RECENT) return `latest ${RANGE_LIMIT} releases`;
  if (range === RANGE_WORST) return `the ${RANGE_LIMIT} worst releases`;
  return 'every tracked release';
}

// Share of logged issues that AMD has documented as fixed.
export function fixRate(bugs = []) {
  if (!bugs.length) return 0;
  return bugs.filter((b) => b.status === 'fixed').length / bugs.length;
}

// A pending issue that no longer appears in the newest release notes. AMD drops
// issues from the list without ever marking them fixed, so this is a real signal
// rather than noise - but it is not proof of a fix.
// `contiguousFrom` is the oldest release from which coverage is known to be complete.
// An issue last seen *before* that point cannot be judged: it may have been relisted
// and then fixed in a release this tracker never captured. The 2019-2021 releases come
// from the Internet Archive and are partial, so this guard is what keeps the signal
// honest instead of turning every coverage gap into a false "possibly fixed".
export function isStale(bug, newestVersion, order, contiguousFrom = null) {
  if (bug.status !== 'pending') return false;
  const last = order.get(bug.last_seen);
  const newest = order.get(newestVersion);
  if (last === undefined || newest === undefined) return false;
  if (last <= newest) return false; // still listed in the newest release
  if (contiguousFrom) {
    const floor = order.get(contiguousFrom);
    // `order` is newest-first, so a LARGER index is OLDER.
    if (floor !== undefined && last > floor) return false; // last seen before the verified window
  }
  return true;
}

// How many issues are in the "stopped being listed" state. Worth surfacing on its own:
// it is the part of the pending count that AMD's newest notes no longer mention.
export function possiblyFixedCount(bugs = [], newestVersion, order = new Map(), contiguousFrom = null) {
  return bugs.reduce(
    (n, b) => n + (isStale(b, newestVersion, order, contiguousFrom) ? 1 : 0), 0);
}

export function haystack(bug) {
  return [
    bug.id, bug.text, bug.game, bug.gpu, bug.first, bug.last_seen, bug.fixed_in,
    ...(bug.sources || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function filterBugs(bugs = [], filters = {}, drivers = []) {
  const { query = '', status = 'all', driver = 'all', channel = 'all', sort = NEWEST_FIRST,
    contiguousFrom = null } = filters;
  const q = query.trim().toLowerCase();
  const { sorted, order } = indexDrivers(drivers);
  const newest = sorted[0]?.version ?? '';

  const channelVersions = new Set(
    drivers.filter((d) => d.channel === channel).map((d) => d.version),
  );

  const rows = bugs.filter((b) => {
    if (status === POSSIBLY_FIXED) {
      if (!isStale(b, newest, order, contiguousFrom)) return false;
    } else if (status !== 'all' && b.status !== status) return false;
    if (driver !== 'all'
      && b.first !== driver
      && b.fixed_in !== driver
      && !(b.sources || []).includes(driver)) return false;
    if (channel !== 'all' && !(b.sources || []).some((v) => channelVersions.has(v))) return false;
    if (!q) return true;
    return haystack(b).includes(q);
  });

  const rank = (b) => order.get(b.first) ?? Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => (sort === OLDEST_FIRST ? rank(b) - rank(a) : rank(a) - rank(b)));
  return rows;
}

export function channels(drivers = []) {
  return [...new Set(drivers.map((d) => d.channel).filter(Boolean))].sort();
}

export function gpus(bugs = []) {
  return [...new Set(bugs.map((b) => b.gpu).filter(Boolean))]
    .filter((g) => g.toLowerCase() !== 'not specified')
    .sort();
}

export function validateDatabase(data) {
  const problems = [];
  if (!data || typeof data !== 'object') return ['data is not an object'];
  if (!Array.isArray(data.drivers) || !data.drivers.length) problems.push('no drivers');
  if (!Array.isArray(data.bugs) || !data.bugs.length) problems.push('no bugs');
  if (problems.length) return problems;
  const versions = new Set(data.drivers.map((d) => d.version));
  const ids = new Set();
  for (const b of data.bugs) {
    if (ids.has(b.id)) problems.push(`duplicate id ${b.id}`);
    ids.add(b.id);
    if (b.first && !versions.has(b.first)) problems.push(`${b.id}: unknown first ${b.first}`);
    if (b.fixed_in && !versions.has(b.fixed_in)) problems.push(`${b.id}: unknown fixed_in ${b.fixed_in}`);
  }
  return problems;
}
