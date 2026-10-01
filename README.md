# AMDWatch

A static, client-side tracker for known issues in AMD Radeon driver release notes.
Follow every issue from first appearance to a documented fix.

No backend, no build step, no runtime dependencies. Three static files, one JSON
database, and a Python importer that turns AMD's release-note pages into review
drafts.

## Run locally

```bash
python -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000

Do not open `index.html` directly. The page fetches `data/tracker.json` and loads
`app.js` as an ES module, and browsers block both over `file://`. If you do open it
directly, the page now says so instead of rendering blank.

## What's here

**The site**
- Search across issue text, game, GPU, driver version and tracker ID
- Filters for status, driver, channel, and sort order — all reflected in the URL,
  so any view is shareable
- Per-release chart showing issues *still open* at each release, split into new
  this release and carried over, alongside the issues documented as fixed in it
- Every issue links to its source release notes
- Deep links: `#AMD-0012` opens straight to that issue
- Explicit loading, empty and error states

**The tooling**
- `scripts/discover_releases.py` — finds which AMD releases still have release notes
  online, and records which ones do not
- `scripts/backfill.py` — rebuilds the whole database from the cached release notes,
  resolving issue identity across releases
- `scripts/import_release_notes.py` — reads one release-note page and emits candidates
  plus match hints against the existing database
- `scripts/validate_tracker.py` — enforces the database invariants
- `scripts/watch_releases.py` — probes for releases we have not logged yet
- `schema/tracker.schema.json` — the record shape, for editors
- `scripts/probe_page.mjs` — drives the real page in headless Chromium and asserts
  what a reader would actually see

## Data status

456 issues across 80 releases, `22.1.1` → `26.9.2`, every release note AMD still
publishes in that window. `meta.contiguous` is `true`: every version in the probed
range was either found and included, or confirmed absent with an HTTP 404.

**The archive starts at `22.1.1` because that is where AMD's published release notes
start.** AMD has removed everything older. RDNA 1 (RX 5000, July 2019) is gone, and so
is RDNA 2's launch window (RX 6000, November 2020) — `19.7.1`, `20.12.1` and `21.12.1`
all return 404. The archive therefore covers RDNA 2, 3 and 4 from early 2022 onward,
not the full life of any of them.

Three caveats worth knowing before trusting a number on the page:

- **Dates before `25.9.2` are month-precision.** Those pages carry no release date at
  all, and their JSON-LD `datePublished` is the *page migration* date, not the driver
  date — `24.8.1` reports `2024-11-08` for a driver that shipped in August. Those dates
  are derived from the version number, so the day is always `01`. See
  `meta.date_precision`.
- **456 is an upper bound on distinct issues.** Two lines are merged automatically only
  above a similarity of 0.95, which catches AMD's copy-paste and its typo fixes but
  deliberately leaves anything less certain as a separate record. `data/review.json`
  lists all 34 automatic merges, 39 reworded variants, and 172 near-misses that were
  *not* merged. A duplicate is recoverable; a wrong merge invents a fix.
- **An issue is `fixed` only where a release lists it under Fixed Issues.** AMD also
  silently drops issues from the notes without saying they were fixed, which is what the
  "Not listed since" badge reports. That is a signal, not proof.

## Importing more releases

```bash
python scripts/import_release_notes.py \
  "https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-9-2.html" \
  --version 26.9.2 --date 2026-09-29 \
  --out candidates/26.9.2.json
```

The importer is deliberately conservative. It never assigns IDs, never merges, and
never decides that two differently worded lines describe the same issue. It emits
a draft plus similarity hints, and a human confirms.

Raw pages are cached under `cache/` (gitignored) so a backfill can be re-parsed
offline with `--offline`.

### How it reads a page

Two structural facts drive the parser, and both were learned the hard way:

1. AMD's pages carry an anchor bar that repeats every section name as a
   navigation link *before* the real heading. Matching a section by "a line of
   text equal to the heading" latches onto the nav link and sweeps the whole page.
   Sections must be read from `h1`–`h4` elements, with nav subtrees ignored.
2. `Fixed Issues` is **not a heading**. It is a bold label inside a list item,
   followed by a nested list. List groups are part of the document structure.

`tests/fixtures/rn-26-9-2.html` reproduces both shapes, so a regression fails CI
rather than quietly producing a wrong draft.

Note: AMD's CDN accepts a bot user agent and then never sends a body. The importer
sends a browser user agent for this reason; see the comment at the top of the file.

## Rebuilding the archive

```bash
# 1. Find every release note AMD still publishes (cached, resumable)
python scripts/discover_releases.py --from 22.1 --to 26.12 --patches 5 \
  --out cache/releases.json

# 2. Rebuild the database from the cached pages. No network.
python scripts/backfill.py --manifest cache/releases.json \
  --out data/tracker.json --review-out data/review.json

# 3. Gate it
python scripts/validate_tracker.py
```

Step 1 probes ~300 candidate versions, because AMD's version numbers are not dense:
months are skipped, and some months ship three patches. Existence is decided on the
`Article Number: RN-RAD-WIN-…` marker in the page body, not on the title or the status
code — `22.3.1` is a real release note whose `<title>` is the legacy URL, and missing
pages come back as either a real 404 or a `404 Page Not Found` body with HTTP 200.

Step 2 does not need the network, so re-running it after a parser change costs nothing.
It is also the only step that decides issue identity; read its output in
`data/review.json` before trusting a merge.

## Staying current

`.github/workflows/watch.yml` runs `scripts/watch_releases.py` daily. It probes a
narrow window around today — not the whole archive — and if AMD has published a release
we have not logged, it rebuilds the database and opens a pull request rather than
pushing to `main`. New releases change issue identity, so the diff wants eyes on it.

```bash
python scripts/watch_releases.py --out .watch/new.json
# exit 0  = up to date
# exit 10 = new releases found
```

## Validating

```bash
python scripts/validate_tracker.py
```

Checks what a JSON Schema cannot: unique IDs, every `first` / `last_seen` /
`fixed_in` / `sources` value resolving to a tracked driver, `fixed` implying a
`fixed_in`, chronological ordering, `sources` covering the endpoints, normalized
text, and duplicate issue text. Exits non-zero so CI can gate on it.

`tests/test_validator_mutations.py` mutates the shipped database once per invariant and
requires the validator to reject it with the expected message. A validator that cannot
fail certifies bad data, so it is mutation-tested rather than trusted.

## Tests

```bash
python -m unittest discover -s tests -t .   # importer, backfill and data invariants
npm test                                    # chart, filter and model logic
npm run test:page -- http://127.0.0.1:8000  # drives the real page (needs a server)
```

The page probe needs `npm ci` and a Chromium download:

```bash
npm ci
npx playwright install chromium
```

## Deploying

`.github/workflows/pages.yml` publishes to GitHub Pages on every push to `main`.
It stages only `index.html`, `app.js`, `style.css`, `lib/` and `data/` into the
published artifact, so the scripts, schema, tests and workflows stay in the
repository and off the site. It refuses to publish if validation or the importer
tests fail.

To enable it: Settings → Pages → Source → **GitHub Actions**. The site then lives
at `https://<user>.github.io/<repo>/`. All asset paths are relative, so the
project subpath works without configuration.

## Known limitations

- **456 issues is an upper bound, not a count of distinct bugs.** 172 near-miss pairs
  are deliberately held apart. The clearest example is Cyberpunk 2077's "intermittent
  system or application crash", which appears as three records as AMD progressively
  widened the GPU scope from unqualified, to RX 7000, to RX 7000 and RX 9000. Whether
  those are one issue or three is a judgement call the threshold cannot make.
- 237 of 456 issues have no game in their text and 232 no GPU model, so the `game` and
  `gpu` fields are `Not specified` for about half the archive. They are derived
  heuristically for filtering; the issue text is the source of truth.
- Dates before `25.9.2` are month-precision. See `meta.date_precision`.
- The chart thins release labels to about twelve and scrolls sideways, because 80 bars
  cannot fit a phone viewport. A much deeper archive would want a coarser x-axis than
  "one bar per release".
- Release-note text is AMD's. The site carries a trademark disclaimer and links every
  issue to its source, and the archive is stored as normalized one-line summaries rather
  than republished pages. **This is a judgement call, not legal advice** — get it reviewed
  before the archive grows or is monetized.

## Suggested next steps

1. Work through `data/review.json`: confirm or reject the 34 automatic merges, and
   decide the 172 near-miss pairs. That is the single biggest quality lever left.
2. Record aliases when an issue's wording changes, so identity survives rewording
   without needing a similarity threshold at all.
3. Decide the Cyberpunk-style "same bug, wider scope" question, and encode the rule.
4. Consider recovering pre-2022 releases from the Internet Archive, which was offline
   during the initial backfill. That is the only route to RDNA 1 and RDNA 2's launch.
