// Pure data logic for AMDWatch. No DOM, no fetch, no globals: this module is
// imported by app.js in the browser and by tests/model.test.mjs under Node.

export const NEWEST_FIRST = 'newest';
export const OLDEST_FIRST = 'oldest';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Drivers are stored newest-first, but never trust the file order.
export function indexDrivers(drivers = []) {
  const sorted = [...drivers].sort((a, b) => {
    if (a.date === b.date) return 0;
    return a.date < b.date ? 1 : -1;
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

// A pending issue that no longer appears in the newest release notes. AMD drops
// issues from the list without ever marking them fixed, so this is a real signal
// rather than noise - but it is not proof of a fix.
export function isStale(bug, newestVersion, order) {
  if (bug.status !== 'pending') return false;
  const last = order.get(bug.last_seen);
  const newest = order.get(newestVersion);
  if (last === undefined || newest === undefined) return false;
  return last > newest; // last_seen is older than the newest release
}

export function haystack(bug) {
  return [
    bug.id, bug.text, bug.game, bug.gpu, bug.first, bug.last_seen, bug.fixed_in,
    ...(bug.sources || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function filterBugs(bugs = [], filters = {}, drivers = []) {
  const { query = '', status = 'all', driver = 'all', channel = 'all', sort = NEWEST_FIRST } = filters;
  const q = query.trim().toLowerCase();
  const { order, byVersion } = indexDrivers(drivers);

  const channelVersions = new Set(
    drivers.filter((d) => d.channel === channel).map((d) => d.version),
  );

  const rows = bugs.filter((b) => {
    if (status !== 'all' && b.status !== status) return false;
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
