import {
  POSSIBLY_FIXED, RANGE_ALL, RANGE_RECENT, RANGE_WORST, RANGE_LIMIT,
  buildSeries, channels, computeStats, escapeHtml, filterBugs, fixRate, gpus,
  indexDrivers, isStale, possiblyFixedCount, rangeLabel, selectSeries, validateDatabase,
} from './lib/model.js';

const DATA_URL = 'data/tracker.json';

const $ = (sel) => document.querySelector(sel);

let DB = null;
let ORDER = new Map();
let NEWEST = '';
// Only meaningful when every release in the window is tracked. With a sparse
// sample an issue can vanish from the notes because it was fixed in a release we
// never imported, so the UI must not present that as "AMD dropped it".
let CONTIGUOUS = false;
// The oldest release from which coverage is complete. Releases before it are recovered
// from the Internet Archive and are partial, so issues last seen in that range cannot be
// judged. `CONTIGUOUS` describes the whole window; this describes where trust starts.
let CONTIGUOUS_FROM = null;
let CAN_JUDGE_STALE = false;
let state = {
  query: '', status: 'all', driver: 'all', channel: 'all',
  sort: 'newest', range: RANGE_RECENT,
};

// ---------------------------------------------------------------- entry point

async function boot() {
  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('the response was not valid JSON');
    }
    const problems = validateDatabase(data);
    if (problems.length) throw new Error(`the database failed validation: ${problems.join('; ')}`);

    DB = data;
    const indexed = indexDrivers(DB.drivers);
    ORDER = indexed.order;
    NEWEST = indexed.sorted[0]?.version ?? '';
    CONTIGUOUS = DB.meta?.contiguous === true;
    CONTIGUOUS_FROM = DB.meta?.contiguous_from || null;
    CAN_JUDGE_STALE = Boolean(CONTIGUOUS_FROM);

    readUrl();
    render();
    bindEvents();
    syncChartControls();
    $('#boot-status').hidden = true;
    $('#app').hidden = false;
  } catch (error) {
    showError(error);
  }
}

function showError(error) {
  const fromFile = window.location.protocol === 'file:';
  const panel = $('#boot-status');
  panel.className = 'panel error-panel';
  panel.removeAttribute('aria-live');
  panel.innerHTML = `
    <div>
      <b>Could not load the issue database</b>
      <span>${escapeHtml(error.message)}</span>
      <span class="error-hint">${fromFile
        ? 'This page is open from the filesystem. Browsers block data requests from <code>file://</code> URLs. '
          + 'Serve the folder instead: <code>python -m http.server 8000</code>, then open '
          + '<a href="http://localhost:8000">http://localhost:8000</a>.'
        : `Expected <code>${escapeHtml(DATA_URL)}</code> to be reachable from this page. Check that the file exists `
          + 'and that the path is correct for wherever this site is hosted.'}</span>
    </div>`;
  panel.hidden = false;
  const notice = $('#coverage');
  notice.innerHTML = '<b>No data</b><span>The tracker could not read its database.</span>';
}

// --------------------------------------------------------------------- render

function render() {
  renderCoverage();
  renderStats();
  renderChart();
  renderDriverOptions();
  renderBugs();
  renderDrivers();
  renderFooter();
}

function renderCoverage() {
  const meta = DB.meta || {};
  const stats = computeStats(DB.drivers, DB.bugs);
  const from = meta.coverage_from || DB.drivers[DB.drivers.length - 1]?.version || '—';
  const to = meta.coverage_to || NEWEST || '—';
  // Two tiers: AMD's own site back to 22.1.1, then an incomplete Internet Archive
  // recovery behind that. Saying which is which is the difference between a number
  // and a claim.
  const window = CONTIGUOUS
    ? 'Every release in this window is tracked.'
    : CONTIGUOUS_FROM
      ? `Every release from ${escapeHtml(CONTIGUOUS_FROM)} onward is tracked. Before that the notes `
        + `were recovered from the Internet Archive and are incomplete, so issues last seen back `
        + `there are left unjudged.`
      : 'The releases in this window are sampled, not complete.';
  $('#coverage').innerHTML = `
    <b>Coverage: ${escapeHtml(from)} to ${escapeHtml(to)}</b>
    <span>${stats.drivers} releases, ${stats.bugs} issues. Last checked
    ${escapeHtml((meta.last_checked || meta.generated || 'unknown').slice(0, 10))}.
    ${window}</span>`;
}

function renderStats() {
  const s = computeStats(DB.drivers, DB.bugs);
  const rate = Math.round(fixRate(DB.bugs) * 100);
  const possibly = CAN_JUDGE_STALE
    ? possiblyFixedCount(DB.bugs, NEWEST, ORDER, CONTIGUOUS_FROM) : 0;
  // "Still pending" counts everything AMD has not documented as fixed, which
  // overstates how many are live: most of them stopped being listed entirely.
  // Showing the split is the difference between a scary number and a real one.
  $('#stats').innerHTML = [
    ['DRIVERS TRACKED', s.drivers],
    ['BUGS LOGGED', s.bugs],
    ['DOCUMENTED FIXES', s.fixed],
    ['STILL PENDING', s.pending],
    ['POSSIBLY FIXED', possibly,
      'Pending issues AMD has stopped listing. They may have been fixed without a note, '
      + 'or the notes may simply have stopped mentioning them. The tracker cannot tell '
      + 'the two apart.'],
    ['FIX RATE', `${rate}%`],
  ].map(([label, value, title]) => `
    <div class="stat"${title ? ` title="${escapeHtml(title)}"` : ''}>
      <strong>${value}</strong><span>${label}</span>
    </div>`).join('');
}

function renderChart() {
  const all = buildSeries(DB.drivers, DB.bugs); // newest first
  // A full archive is ~80 releases. Showing every one at once is unreadable, so the
  // chart shows a window by default and `All time` is an explicit choice.
  const series = selectSeries(all, state.range).reverse(); // oldest on the left

  // Two scales, because the two quantities differ by an order of magnitude and forcing
  // them onto one axis is what made the old chart unreadable. In the default window the
  // unfixed backlog only moves between 105 and 119 while new/fixed per release are 0-11,
  // so a shared 0-119 axis drew every release as the same near-full-height column with a
  // hairline cap on top: a wall of identical pylons that encoded almost nothing.
  //
  //   backlog -> a line, scaled 0..max(open), so its height never overstates the level
  //   churn   -> diverging bars around a zero line, scaled to max(new, fixed)
  const churnPeak = Math.max(1, ...series.map((s) => Math.max(s.introduced, s.fixedHere)));
  const maxOpen = Math.max(1, ...series.map((s) => s.open));
  // Thin the labels out once releases get numerous, so they never collide. The
  // tooltip always carries the exact version.
  const labelStep = Math.max(1, Math.ceil(series.length / 12));

  const chart = $('#chart');
  // One bar per release now instead of two, so the columns can be narrower.
  chart.style.minWidth = series.length > 12 ? `${series.length * 22}px` : '';

  // A point sits at i + 0.5 in a 0..n viewBox, which is the centre of flex column i, so
  // the line stays over its release however wide the plot is scrolled to. The 4/92 inset
  // keeps a full-height line off the strip's edges, where the stroke would be clipped.
  const points = series.map((s, i) => [i + 0.5, 96 - (s.open / maxOpen) * 92]);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `M${points[0][0]},100 L${line.replace(/ /g, ' L')} L${points.at(-1)[0]},100 Z`;
  const newestInWindow = series.at(-1);

  $('#trend').innerHTML = `
    <span class="trend-name">Unfixed backlog</span>
    <span class="trend-end">${newestInWindow.open} at ${escapeHtml(newestInWindow.version)}</span>
    <svg viewBox="0 0 ${series.length} 100" preserveAspectRatio="none" aria-hidden="true">
      <path class="trend-area" d="${area}"/>
      <polyline class="trend-line" points="${line}" vector-effect="non-scaling-stroke"/>
    </svg>`;

  $('#chart-bars').innerHTML = series.map((s, i) => {
    const upPct = (s.introduced / churnPeak) * 100;
    const downPct = (s.fixedHere / churnPeak) * 100;
    const title = `${s.version} (${s.date}, ${s.channel})\n`
      + `${s.introduced} new this release, ${s.fixedHere} documented as fixed\n`
      + `${s.open} unfixed at this release — ${s.carried} of them carried over from earlier releases\n`
      + `Click to filter the list to this release`;

    return `
      <div class="bar-wrap" data-driver="${escapeHtml(s.version)}" role="button" tabindex="0"
           aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">
        <div class="col">
          <div class="up"><span class="seg introduced" data-zero="${s.introduced === 0}" style="height:${upPct}%"></span></div>
          <div class="down"><span class="seg closed" data-zero="${s.fixedHere === 0}" style="height:${downPct}%"></span></div>
        </div>
        <span class="bar-label">${i % labelStep === 0 ? escapeHtml(s.version) : ''}</span>
      </div>`;
  }).join('');

  const totalFixed = series.reduce((sum, s) => sum + s.fixedHere, 0);
  const totalNew = series.reduce((sum, s) => sum + s.introduced, 0);
  const pending = computeStats(DB.drivers, DB.bugs).pending;
  const possibly = CAN_JUDGE_STALE
    ? possiblyFixedCount(DB.bugs, NEWEST, ORDER, CONTIGUOUS_FROM) : 0;
  const shown = state.range === RANGE_ALL
    ? `every tracked release` : rangeLabel(state.range);
  const scrollHint = series.length > 12 && state.range === RANGE_ALL
    ? ` The plot scrolls sideways to fit ${series.length} releases.` : '';
  $('#chart-note').textContent = series.length
    ? `Showing ${shown}. Above the line: issues first listed in that release. Below it: issues that release `
      + `documented as fixed. The line is the unfixed backlog, on its own scale. `
      + `Over this window ${totalNew} issues were added and ${totalFixed} documented as fixed, taking the `
      + `backlog from ${series[0].open} to ${newestInWindow.open}. `
      + (CAN_JUDGE_STALE
        ? `${possibly} of the ${pending} pending issues have stopped being listed altogether, so they are `
          + `"possibly fixed" rather than open — AMD drops issues from the notes without ever saying so.`
          + (CONTIGUOUS ? ''
            : ` Issues last seen before ${CONTIGUOUS_FROM} are excluded, because the archive is`
              + ` incomplete back there and their last appearance cannot be trusted.`)
        : `Coverage is not contiguous, so an issue that disappears between two tracked releases may have been `
          + `fixed in a release this tracker does not have. Treat "open" here as "not yet documented as fixed".`)
      + scrollHint
    : 'No releases to chart.';
}

function renderDriverOptions() {
  const driverSelect = $('#driver');
  driverSelect.innerHTML = '<option value="all">All drivers</option>'
    + [...DB.drivers]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((d) => `<option value="${escapeHtml(d.version)}">${escapeHtml(d.version)}</option>`).join('');
  driverSelect.value = state.driver;

  const channelSelect = $('#channel');
  channelSelect.innerHTML = '<option value="all">All channels</option>'
    + channels(DB.drivers).map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  channelSelect.value = state.channel;

  // Only offered when the coverage window is unbroken. With a sparse archive an issue
  // can vanish simply because it was fixed in a release this tracker never imported,
  // which would make the filter a lie.
  const statusSelect = $('#status');
  const existing = statusSelect.querySelector(`option[value="${POSSIBLY_FIXED}"]`);
  if (CAN_JUDGE_STALE && !existing) {
    statusSelect.insertAdjacentHTML('beforeend',
      `<option value="${POSSIBLY_FIXED}">Possibly fixed (no longer listed)</option>`);
  } else if (!CAN_JUDGE_STALE && existing) {
    existing.remove();
  }
  statusSelect.value = state.status;
}

function renderBugs() {
  const rows = filterBugs(DB.bugs, { ...state, contiguousFrom: CONTIGUOUS_FROM }, DB.drivers);
  $('#count').textContent = `${rows.length} of ${DB.bugs.length} issues`;

  if (!rows.length) {
    $('#bugs').innerHTML = `
      <p class="muted empty">No matching issues.
      <button type="button" class="link-button" id="clear-filters">Clear all filters</button></p>`;
    $('#clear-filters')?.addEventListener('click', clearFilters);
    return;
  }

  $('#bugs').innerHTML = rows.map((bug) => {
    const sources = (bug.sources || []).map((version) => {
      const driver = DB.drivers.find((d) => d.version === version);
      const label = escapeHtml(version);
      return driver
        ? `<a href="${escapeHtml(driver.url)}" target="_blank" rel="noopener">${label}</a>`
        : label;
    }).join(', ');

    const stale = CAN_JUDGE_STALE && isStale(bug, NEWEST, ORDER, CONTIGUOUS_FROM);
    const lastSeen = stale
      ? `<span class="pill stale" title="AMD listed this issue, then stopped. It may have been fixed without a note, or the notes may just have stopped mentioning it — the release notes cannot tell the two apart, so this tracker does not guess.">Possibly fixed · not listed since ${escapeHtml(bug.last_seen)}</span>`
      : `<span>Last seen: ${escapeHtml(bug.last_seen)}</span>`;

    return `
      <article class="bug" id="${escapeHtml(bug.id)}">
        <div class="bug-top">
          <a class="bug-id" href="#${escapeHtml(bug.id)}">${escapeHtml(bug.id)}</a>
          <span class="pill ${escapeHtml(bug.status)}">${escapeHtml(bug.status)}</span>
        </div>
        <p>${escapeHtml(bug.text)}</p>
        <div class="meta">
          <span>First seen: ${escapeHtml(bug.first)}</span>
          ${lastSeen}
          ${bug.fixed_in ? `<span>Fixed in: ${escapeHtml(bug.fixed_in)}</span>` : ''}
          <span>GPU: ${escapeHtml(bug.gpu)}</span>
          <span>${escapeHtml(bug.game)}</span>
          <span>Sources: ${sources}</span>
        </div>
      </article>`;
  }).join('');
}

function renderDrivers() {
  $('#drivers').innerHTML = DB.drivers.map((driver) => {
    const open = buildSeries([driver], DB.bugs)[0]?.open ?? 0;
    // Archived releases are no longer on amd.com, so the link goes to the snapshot
    // and the row says so. Without the marker the link would look like any other.
    const archived = driver.archived === true;
    const badge = archived
      ? ' <span class="pill archived" title="AMD no longer publishes this release note. Recovered from the Internet Archive.">archived</span>'
      : '';
    return `
      <div class="driver">
        <div>
          <b>${escapeHtml(driver.version)}</b>${badge}
          <div class="muted">${escapeHtml(driver.date)} · ${escapeHtml(driver.channel)} · ${open} open</div>
        </div>
        <div class="driver-links">
          <button type="button" class="link-button" data-filter-driver="${escapeHtml(driver.version)}">Filter</button>
          <a href="${escapeHtml(driver.url)}" target="_blank" rel="noopener">${archived ? 'Archived notes ↗' : 'Release notes ↗'}</a>
        </div>
      </div>`;
  }).join('');
}

function renderFooter() {
  const meta = DB.meta || {};
  $('#foot-meta').textContent = `${meta.method || ''} Generated ${meta.generated || 'unknown'}.`;
}

// --------------------------------------------------------------------- events

function bindEvents() {
  const search = $('#search');
  search.value = state.query;

  search.addEventListener('input', () => {
    state.query = search.value;
    update();
  });

  for (const id of ['status', 'driver', 'channel', 'sort']) {
    const el = $(`#${id}`);
    el.value = state[id];
    el.addEventListener('change', () => {
      state[id] = el.value;
      update();
    });
  }

  for (const chip of document.querySelectorAll('#chart-range .chip')) {
    chip.addEventListener('click', () => {
      state.range = chip.dataset.range;
      syncChartControls();
      renderChart();
      writeUrl();
    });
  }

  // The chart doubles as a filter: clicking a release narrows the list to it, which
  // is the fastest way to answer "what was actually open in 26.8.1".
  const chart = $('#chart');
  chart.addEventListener('click', (event) => {
    const bar = event.target.closest('[data-driver]');
    if (bar) applyDriverFilter(bar.dataset.driver);
  });
  chart.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const bar = event.target.closest('[data-driver]');
    if (!bar) return;
    event.preventDefault();
    applyDriverFilter(bar.dataset.driver);
  });

  $('#drivers').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter-driver]');
    if (button) applyDriverFilter(button.dataset.filterDriver);
  });

  window.addEventListener('hashchange', () => {
    const id = window.location.hash.slice(1);
    if (DB.bugs.some((b) => b.id === id)) {
      state.query = id;
      state.status = 'all';
      state.driver = 'all';
      $('#search').value = id;
      $('#status').value = 'all';
      $('#driver').value = 'all';
      update();
    }
  });
}

function applyDriverFilter(version) {
  state.driver = version;
  state.query = '';
  $('#driver').value = version;
  $('#search').value = '';
  update();
  document.getElementById('bugs').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function syncChartControls() {
  for (const chip of document.querySelectorAll('#chart-range .chip')) {
    const on = chip.dataset.range === state.range;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  }
}

function clearFilters() {
  // Range and carried-over are view settings rather than filters: clearing the
  // search should not silently change what the chart is showing.
  state = { ...state, query: '', status: 'all', driver: 'all', channel: 'all', sort: 'newest' };
  $('#search').value = '';
  $('#status').value = 'all';
  $('#driver').value = 'all';
  $('#channel').value = 'all';
  $('#sort').value = 'newest';
  update();
}

function update() {
  renderBugs();
  writeUrl();
}

// ------------------------------------------------------------------------ url

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash.slice(1);

  state.query = params.get('q') || '';
  const status = params.get('status');
  state.status = ['all', 'pending', 'fixed'].includes(status)
    || (status === POSSIBLY_FIXED && CAN_JUDGE_STALE) ? status : 'all';
  state.channel = params.get('channel') || 'all';
  state.sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';
  const range = params.get('range');
  state.range = [RANGE_RECENT, RANGE_WORST, RANGE_ALL].includes(range) ? range : RANGE_RECENT;
  const driver = params.get('driver');
  state.driver = DB.drivers.some((d) => d.version === driver) ? driver : 'all';

  // A deep link to a single issue takes priority over other filters.
  if (hash && DB.bugs.some((b) => b.id === hash)) {
    state = { ...state, query: hash, status: 'all', driver: 'all' };
  }
}

function writeUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.status !== 'all') params.set('status', state.status);
  if (state.driver !== 'all') params.set('driver', state.driver);
  if (state.channel !== 'all') params.set('channel', state.channel);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  if (state.range !== RANGE_RECENT) params.set('range', state.range);
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}${window.location.hash}` : window.location.pathname + window.location.hash);
}

boot();
