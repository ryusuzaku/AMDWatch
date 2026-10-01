import {
  RANGE_ALL, RANGE_RECENT, RANGE_WORST, RANGE_LIMIT,
  buildSeries, channels, computeStats, escapeHtml, filterBugs, fixRate, gpus,
  indexDrivers, isStale, rangeLabel, selectSeries, validateDatabase,
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
let state = {
  query: '', status: 'all', driver: 'all', channel: 'all',
  sort: 'newest', range: RANGE_RECENT, carried: true,
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
  $('#coverage').innerHTML = `
    <b>Coverage: ${escapeHtml(from)} to ${escapeHtml(to)}</b>
    <span>${stats.drivers} releases, ${stats.bugs} issues. Last checked
    ${escapeHtml((meta.last_checked || meta.generated || 'unknown').slice(0, 10))}.
    ${CONTIGUOUS
      ? 'Every release in this window is tracked.'
      : 'The releases in this window are sampled, not complete.'}</span>`;
}

function renderStats() {
  const s = computeStats(DB.drivers, DB.bugs);
  const rate = Math.round(fixRate(DB.bugs) * 100);
  $('#stats').innerHTML = [
    ['DRIVERS TRACKED', s.drivers],
    ['BUGS LOGGED', s.bugs],
    ['DOCUMENTED FIXES', s.fixed],
    ['STILL PENDING', s.pending],
    ['FIX RATE', `${rate}%`],
  ].map(([label, value]) => `
    <div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
}

function renderChart() {
  const all = buildSeries(DB.drivers, DB.bugs); // newest first
  // A full archive is ~80 releases. Showing every one at once is unreadable, so the
  // chart shows a window by default and `All time` is an explicit choice.
  const series = selectSeries(all, state.range).reverse(); // oldest on the left
  const peak = Math.max(1, ...series.map((s) => Math.max(s.open, s.fixedHere)));
  // Thin the labels out once releases get numerous, so they never collide. The
  // tooltip always carries the exact version.
  const labelStep = Math.max(1, Math.ceil(series.length / 12));

  const chart = $('#chart');
  chart.style.minWidth = series.length > 12 ? `${series.length * 26}px` : '';

  chart.innerHTML = series.map((s, i) => {
    const openPct = (s.open / peak) * 100;
    // Carried-over issues are issues that existed in an earlier release and had not
    // been fixed by this one. The toggle folds them into "new" rather than dropping
    // them, so the bar still shows how many were open.
    const carried = state.carried ? s.carried : 0;
    const carriedPct = s.open ? (carried / s.open) * openPct : 0;
    const introducedPct = openPct - carriedPct;
    const fixedPct = (s.fixedHere / peak) * 100;

    const title = `${s.version} (${s.date}, ${s.channel})\n`
      + `${s.open} open — ${s.open - carried} new this release, ${carried} carried over\n`
      + `${s.fixedHere} documented as fixed in this release\n`
      + `Click to filter the list to this release`;

    return `
      <div class="bar-wrap" data-driver="${escapeHtml(s.version)}" role="button" tabindex="0"
           aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">
        <div class="bar-group">
          <div class="bar open" data-zero="${s.open === 0}">
            <div class="seg introduced" style="height:${introducedPct}%"></div>
            <div class="seg carried" style="height:${carriedPct}%"></div>
          </div>
          <div class="bar fixed" data-zero="${s.fixedHere === 0}">
            <div class="seg closed" style="height:${fixedPct}%"></div>
          </div>
        </div>
        <span class="bar-label">${i % labelStep === 0 ? escapeHtml(s.version) : ''}</span>
      </div>`;
  }).join('');

  const worst = series.reduce((a, b) => (b.open > a.open ? b : a), series[0]);
  const totalFixed = series.reduce((sum, s) => sum + s.fixedHere, 0);
  const shown = state.range === RANGE_ALL
    ? `every tracked release` : rangeLabel(state.range);
  const scrollHint = series.length > 12 && state.range === RANGE_ALL
    ? ` The plot scrolls sideways to fit ${series.length} releases.` : '';
  $('#chart-note').textContent = series.length
    ? `Showing ${shown}. Left bar: issues still open at that release. Right bar: issues documented as fixed in it. `
      + `Peak is ${worst.open} open at ${worst.version}; ${totalFixed} fixes are documented in this window. `
      + (state.carried ? '' : 'Carried-over issues are folded into "new". ')
      + (CONTIGUOUS
        ? 'A pending issue that stops being listed is not proof of a fix — AMD drops issues from the notes without saying so.'
        : `Coverage is not yet contiguous, so an issue that disappears between two tracked releases may have been `
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
}

function renderBugs() {
  const rows = filterBugs(DB.bugs, state, DB.drivers);
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

    const stale = CONTIGUOUS && isStale(bug, NEWEST, ORDER);
    const lastSeen = stale
      ? `<span class="pill stale" title="AMD stopped listing this issue without documenting a fix">Not listed since ${escapeHtml(bug.last_seen)}</span>`
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
    return `
      <div class="driver">
        <div>
          <b>${escapeHtml(driver.version)}</b>
          <div class="muted">${escapeHtml(driver.date)} · ${escapeHtml(driver.channel)} · ${open} open</div>
        </div>
        <div class="driver-links">
          <button type="button" class="link-button" data-filter-driver="${escapeHtml(driver.version)}">Filter</button>
          <a href="${escapeHtml(driver.url)}" target="_blank" rel="noopener">Release notes ↗</a>
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

  $('#carried-toggle').addEventListener('change', (event) => {
    state.carried = event.target.checked;
    renderChart();
    writeUrl();
  });

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
  $('#carried-toggle').checked = state.carried;
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
  state.status = ['all', 'pending', 'fixed'].includes(params.get('status')) ? params.get('status') : 'all';
  state.channel = params.get('channel') || 'all';
  state.sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';
  const range = params.get('range');
  state.range = [RANGE_RECENT, RANGE_WORST, RANGE_ALL].includes(range) ? range : RANGE_RECENT;
  state.carried = params.get('carried') !== '0';
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
  if (!state.carried) params.set('carried', '0');
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}${window.location.hash}` : window.location.pathname + window.location.hash);
}

boot();
