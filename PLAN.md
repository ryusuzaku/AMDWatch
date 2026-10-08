# AMDWatch — gap analysis and completion plan

> **Implementation status (2026-10-08).** This document is the audit of the starter as
> it was *before* the work landed. Everything below B1–B9 and the phases have since been
> implemented and verified; the counts and bug descriptions here describe the original
> state, not the current one. See `README.md` for the current state.
>
> - B1–B9: all fixed. The importer was rewritten around document structure, text is
>   normalized, the fetch has real error/loading/empty states, `last_seen` is shown, the
>   chart models carried-over issues, and there is a validator gating CI.
> - Phases 0, 1, 2, 3 and 5: done.
> - Phase 4 (backfill): done, covering every release note AMD still publishes,
>   `22.1.1` → `26.9.2`. RDNA 1 and RDNA 2's launch were subsequently recovered from the
>   Internet Archive, then **deliberately excluded from the shipped archive**: the
>   recovered range is gappy, carries month-precision dates, and cannot be judged, so it
>   made the site's claims untrue rather than richer. The recovery is opt-in and still
>   works — see "Recovering releases AMD deleted" in `README.md`.
> - Phase 5's "scheduled job" (the optional last step) is now built:
>   `.github/workflows/watch.yml` plus `scripts/watch_releases.py`.
> - Verification now in place: see the Tests section of `README.md`.

Status: review of the starter as it stands on 2026-10-01. Everything below was verified against
the files in this repo and against the live AMD release-note pages, not inferred from the README.

---

## Implementation status (updated 2026-10-01)

Phases 0–3 are done. Phase 4 (data backfill) and Phase 5.2 (scheduled upstream check) remain.

| Phase | Item | State |
|---|---|---|
| 0.1 | `git init`, baseline, `.gitignore`, `LICENSE` | repo prepared; baseline commit awaiting review |
| 0.2 | JSON Schema + `validate_tracker.py` | done — 9/9 mutation checks caught |
| 1.1 | Heading-structure parsing (B1) | done |
| 1.2 | Text normalization (B2) | done |
| 1.3 | Page-furniture filtering | done |
| 1.4 | Fixed→Known carry-over flagging (B3) | done |
| 1.5 | `--cache` / `--offline` / `--delay` | done |
| 1.6 | `candidates.json` with match hints | done |
| 2.1 | Loading / empty / error states (B4) | done |
| 2.2 | `last_seen` surfaced (B8) | done |
| 2.3 | Chart semantics respect persistence (B5) | done |
| 2.4 | Phantom zero bar removed (B6) | done |
| 2.5 | All interpolation escaped (B7) | done |
| 2.6 | Deep links per issue and per driver | done |
| 3.1 | Importer fixture test (would have caught B1) | done — 24 tests |
| 3.2 | Model tests for filter/chart logic | done — 18 tests |
| 3.3 | Validator in CI | done |
| 3.4 | Rendered-page smoke check | done — 31 checks, verified under a Pages subpath |
| 4.x | Backfill and review queue | **not started** |
| 5.1 | GitHub Pages workflow | done |
| 5.2 | Scheduled upstream check | **not started** |

Two findings changed the design during implementation:

- **AMD's CDN hangs non-browser user agents** rather than rejecting them. A self-identifying UA
  times out at 20 s on every attempt; a browser UA returns 167 KB in 0.3 s. Retries do not help.
- **`meta.contiguous` was added.** With a sparse sample, an issue that vanishes from the release
  notes may simply have been fixed in an untracked release. The UI must not present that as
  "AMD dropped it", so the signal is gated until the coverage window is unbroken.

The sections below are the original analysis and remain the record of what was wrong and why.

---

## 1. What actually exists

| File | Lines / size | Notes |
|---|---|---|
| `index.html` | 11 lines, minified | Single page, no `<noscript>`, no meta description, no favicon |
| `app.js` | 7 lines, minified | Top-level functions, no modules, no build step |
| `style.css` | 4.4 KB, minified | Dark theme, one 700px breakpoint |
| `data/tracker.json` | 6 drivers, 25 bugs, 1 `meta` | Internally consistent (see below) |
| `scripts/import_release_notes.py` | 45 lines, stdlib only | Runs, but produces wrong output (see B1) |
| `README.md` | — | Honest about scope; correctly calls itself a starter |

Not present: git repository, LICENSE, .gitignore, package.json, any test, any CI,
JSON schema, data validator.

**Data integrity check (passed).** 25 records, no duplicate IDs, every `first` / `last_seen` /
`fixed_in` / `sources` value resolves to a driver in the `drivers` array, `status: fixed`
always has a `fixed_in`, `status: pending` never does, and driver dates are strictly
descending. 15 pending / 10 fixed. The sample is clean — it is just small.

**URL check (passed).** The release-note URL pattern resolves: `RN-RAD-WIN-26-9-2.html` and
`RN-RAD-WIN-25-6-1.html` both return HTTP 200 with real content (167 KB, containing
`Highlights`, `Known Issues`, `Additional Information` headings). The links are not broken.

**Coverage check (failed).** The README says the sample is "manually transcribed from selected
AMD release notes". For 26.9.2 specifically, the live page lists four Known Issues that are not
in `tracker.json` at all:

- Intermittent application crash while playing Assassin's Creed Black Flag Resynced on RX 7000
- Intermittent driver timeout while playing War Thunder on RX 5000 series

So the dataset is incomplete even for the releases it claims to sample. That is worth stating
plainly, because it sets the real size of the backfill job.

---

## 2. Outstanding bugs

Ordered by how much they block progress, not by how hard they are to fix.

### B1 — The importer keys off navigation links, not section headings (blocker)

`section_lines()` activates when it sees *any* text line equal to the heading string. On a real
AMD page the first occurrence of "Known Issues" is the anchor-bar nav link, not the section:

```
byte 133304: <a href="#Known_Issues" class="nav-link anchor-bar-link"> Known Issues </a>
byte 136049: <h2><a id="Known_Issues"></a>Known Issues</h2>      <- the real heading
```

The extractor latches onto the nav link and then sweeps the entire page body until it hits a
stop heading. Observed output for `--version 26.9.2`:

- `known_issue_candidates` contains Highlights content (`Call of Duty: Modern Warfare 4 campaign
  early access`, `The Witcher 3: Wild Hunt — Remastered`) and page furniture
  (`Last Updated: September 29th, 2026.`)
- all four Fixed Issues entries appear in **both** lists, because `Fixed Issues` is not in the
  Known Issues stop list
- `fixed_issue_candidates` is therefore a strict subset of `known_issue_candidates`

The lists are unusable without manual surgery, which defeats the entire point of the scaffold.
The heading list on that page is `Highlights`, `Known Issues`, `Additional Information`,
`Packaged Contents` — there is no `Fixed Issues` heading element at all, which is why the
existing stop-heading list cannot work.

### B2 — No text normalization, so imported text can never match stored records (blocker)

AMD emits `Radeon™ RX 7000 series graphics products.` and
`AMD Software: Adrenalin Edition`. `tracker.json` stores `Radeon RX 7000` and `AMD Software`.
The importer strips neither `™`/`®` nor the channel suffix. Every import will look like a brand
new issue. README step 2 ("normalize issue identity across wording changes") is currently
impossible to execute.

### B3 — Fixed→Known carry-over is not detected (high)

Four of the 26.9.2 fixed issues are also listed under Known Issues in a later release. Nothing
marks that relationship, so a reviewer can create phantom "still pending" records — the exact
false-merge failure the README warns about, from the other direction.

### B4 — The data fetch has no error path (high, user-visible)

```js
fetch('data/tracker.json').then(r=>r.json()).then(d=>{DB=d;init()});
```

No `.catch()`, no loading state, no empty state. Opened over `file://`, or if the JSON is
corrupt or 404s, every section renders blank with no explanation. The README works around this
with "Do not open `index.html` directly" — documentation patching a UI defect.

### B5 — The chart ignores `last_seen`, contradicting the product claim (medium)

`renderChart()` buckets by `first` only. The hero copy promises "follow issues from first
appearance to a documented fix". A bug first seen in 25.6.1 that is still open in the newest
driver is drawn as a single bar at its origin release. The chart understates how many issues are
live in recent releases — the one question the chart exists to answer.

### B6 — Phantom bar for releases with zero issues (low, latent)

`Math.max(4, ...)` guarantees a visible bar even when `list.length === 0`, and the tooltip still
reads "0 tracked issues". Currently masked because all six sampled drivers have at least one
issue. It appears the moment the dataset grows, which is the whole point.

### B7 — Unescaped interpolation outside `renderBugs()` (low, latent)

`renderBugs()` routes text through `esc()`. `renderDrivers()` and `renderChart()` interpolate
`version`, `date`, `channel`, `url` and the bar label raw. Harmless with hand-curated JSON,
unsafe the moment the importer writes into the data file — which is the stated direction.

### B8 — `last_seen` is stored and searchable but never displayed (medium)

The field is in every record and in the search haystack, but no card renders it. The single most
useful fact for a user — "this bug is still open in the newest driver" — is invisible.

### B9 — No data validation anywhere (medium)

Nothing enforces unique IDs, resolvable version references, `fixed_in` implying `fixed`, or
descending driver dates. The current file passes all of these by luck and discipline. There is
no gate, and the importer is about to start feeding it.

---

## 3. Missing functionality

**Data layer**
- JSON Schema for `tracker.json`, plus a validator wired into the import path.
- ID allocation: IDs exist but are hand-assigned. No allocator, no alias index.
- Issue identity model: `aliases: []` and a normalized key, so a wording change does not fork a
  record.
- A review queue: `import → candidates.json → human review → merge`, with the merge step
  refusing to clobber hand-edited fields.
- Historical backfill. Six releases is not an archive; the URL pattern is regular and verified,
  so this is a crawl, not a research project.
- `meta.generated` is hand-set to today's date and nothing updates it. There is no
  "last checked" or coverage-window field.

**Front end**
- Loading / empty / error states.
- `last_seen` and a "still open in <newest driver>" badge.
- Deep links per issue (`#AMD-0012`) and a filtered view per driver.
- Sorting (newest first, most persistent) and GPU/game facets.
- Channel filter (`Optional` vs `Adrenalin`) — `channel` is already in the data and unused.
- Chart semantics: either a real time axis, or an explicit "release index" label with a series
  that respects persistence.

**Delivery**
- Git repo, LICENSE, .gitignore.
- GitHub Pages workflow (README step 4).
- Tests: schema validation, `app.js` logic tests, and an importer test against a saved HTML
  fixture. That last one is what would have caught B1.
- A static-only constraint check. This ships with no credentials and no server; that is an
  asset, and nothing in the plan should quietly spend it.

---

## 4. Dependencies and constraints

- **Toolchain.** Currently Python 3 stdlib only, and a zero-build front end. Growing the crawler
  means `requests` + `beautifulsoup4` (or `lxml`) — `HTMLParser` plus regex is what produced B1.
  Adding a JS toolchain (Vite/Vitest) is the other real decision. Both are cheap now and
  expensive after Phase 4.
- **No-build is a feature.** The site runs from `python -m http.server`. Keep it, or trade it
  away deliberately.
- **Legal.** AMD release notes are copyrighted. Republishing full verbatim bullets is a genuine
  risk, and the README does not mention it. The safe model is short normalized summaries plus a
  link to the source, which also happens to be what the identity model wants. Decide this
  before the backfill, not after — it determines what the crawler is allowed to store.
- **Matching is human work.** No automation can decide that two wordings are the same bug. The
  design must keep a human in the loop and make the diff reviewable.

---

## 5. Implementation steps

### Phase 0 — Freeze and instrument
1. `git init`, add `LICENSE` and `.gitignore`, commit the current state as the baseline.
   *(Ask Tomi before committing — no commits land unreviewed.)*
2. Add `schema/tracker.schema.json` and `scripts/validate_tracker.py`; make the import path call
   the validator. Turns B9 into a gate instead of a hope.

### Phase 1 — Make the importer trustworthy *(unblocks everything else)*
1. Rewrite section detection to consume heading structure — tag, level and anchor `id` — instead
   of matching text. Fixes B1.
2. Add a normalization pass: strip `™ ® ©`, collapse whitespace, normalize curly quotes, em/en
   dashes and ellipsis, fold `AMD Software: Adrenalin Edition` → `AMD Software`. Fixes B2.
3. Drop page furniture by pattern (`Last Updated:`, page title, "installation package can be
   downloaded from", compatibility lists). Clears the rest of B1.
4. Flag items appearing in both Fixed and Known within one release. Fixes B3.
5. Add `--cache` (store raw HTML) and `--fixtures` so tests run offline.
6. Emit `candidates.json` shaped like tracker records with `id: null`, plus `match_hints`
   (normalized key, nearest existing records). Never auto-merge.

### Phase 2 — Front-end correctness
1. Add loading, empty and error states, including a visible "data could not be loaded" panel with
   the local-server hint. Fixes B4.
2. Render `last_seen` and the "still open in …" badge. Fixes B8.
3. Fix chart semantics so persisted issues are visible. Fixes B5.
4. Remove the phantom 4% bar; render a real zero state. Fixes B6.
5. Escape all interpolation, or move to DOM construction / `textContent`. Fixes B7.
6. Deep links per issue and per driver.

### Phase 3 — Verification
1. `tests/test_importer.py` against a saved 26.9.2 fixture: assert Highlights text is absent,
   Fixed and Known do not overlap, counts match. **This test fails today — that is the point.**
2. Extract the filter and chart logic into pure functions, then test them.
3. Run `validate_tracker.py` in CI.
4. Rendered-page smoke check: serve, load headless, assert the stat, chart and bug counts.

### Phase 4 — Data
1. Backfill: crawl the release-note index back to the oldest available Adrenalin release, caching
   raw HTML, running the importer per release.
2. Review queue: confirm, reject or merge each candidate. Set `first_seen`, `last_seen` and
   `fixed_in` from evidence in the notes, never from the diff.
3. Promote reviewed records with a merge script that refuses to overwrite hand-edited fields
   without an explicit flag.
4. Publish the coverage window and a real last-checked timestamp in `meta`.

### Phase 5 — Ship
1. GitHub Pages workflow (static, no build) and a README refresh for run and deploy.
2. Optional: a scheduled Action that re-checks the newest release note and opens a PR containing
   a candidates diff. This is the only way the tracker stays current without manual effort.

---

## 6. Definition of done

- Served locally, the page handles a missing or corrupt data file with a real message, shows
  `last_seen`, and the chart does not misrepresent persistence.
- `scripts/validate_tracker.py` passes in CI on every change.
- `pytest` importer test passes against a stored fixture, and fails when the heading parser
  regresses.
- Coverage spans a stated window of releases, and every record is traceable to a source URL and
  a recorded review decision.
- Live on Pages, with the trademark disclaimer and the coverage window visible on the page.

---

## 7. If only three things get done

1. **B1** — roughly a 15-line rewrite of `section_lines()`, and it is the gate on all data work.
2. **B2** — without normalization, no record added by import can ever match an existing one.
3. **B4** — the failure every first-time user will hit, and the one the README currently
   documents around instead of fixing.
