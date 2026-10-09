# AMDWatch

A static, client-side tracker for known issues in AMD Radeon driver release notes.
Follow every issue from first appearance to a documented fix.

No backend, no build step, no runtime dependencies. Three static files, one JSON
database, and a set of Python scripts that turn AMD's release-note pages into a
reviewable issue history. The scripts can also recover release notes AMD has deleted,
from the Internet Archive — that range is deliberately **not** in the shipped archive,
and the README says why.

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
- A per-release chart on **two scales**. Bars diverge from a zero line — issues first listed
  above it, issues documented as fixed below. Above them a line tracks the **backlog**, which
  is only the issues AMD still lists; the ones it has stopped listing are reported separately
  and never added to it. Each needs its own axis: the churn per release is 0–11 while the raw
  unfixed pile reaches 119, and on a single axis the pile swallows the churn so every release
  renders as an identical full-height column — which is what it used to do
- The chart shows a **window** of releases, not the whole archive — `Latest 20`
  by default, plus `Most affected` and `All time`. 80 columns at once is unreadable,
  and the window is what makes the trend legible. The choice is in the URL.
- **Click any bar to filter the issue list to that release**
- A **"Possibly fixed (no longer listed)"** status filter, and a tile counting them, so
  the issues that need a human to confirm are one click away
- A fix-rate tile alongside the totals
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
- `scripts/check_rebuild.py` — the delta guard that decides whether a rebuild is ordinary
  churn or needs a human
- `scripts/discover_archived.py` — recovers release notes AMD has deleted, from the
  Internet Archive. Opt-in, and **not** part of the shipped archive; see "Recovering
  releases AMD deleted"
- `schema/tracker.schema.json` — the record shape, for editors
- `scripts/probe_page.mjs` — drives the real page in headless Chromium and asserts
  what a reader would actually see

## Data status

**456 issues across 80 releases, `22.1.1` → `26.9.2`.** That is every AMD Adrenalin
release note AMD still publishes, and `meta.contiguous` is `true`: every version in the
probed window was either found and included, or confirmed absent with an HTTP 404.

The archive starts at `22.1.1` because that is where AMD's published notes start. AMD
deleted everything older, and **that older range is deliberately not included** even
though the tooling can recover most of it — see "Recovering releases AMD deleted" below.

Five things to know before trusting a number on the page:

- **456 is an upper bound on distinct issues.** Two lines are merged automatically only
  above a similarity of 0.95, which catches AMD's copy-paste and its typo fixes but
  deliberately leaves anything less certain as a separate record. `data/review.json`
  lists all 34 automatic merges, the 39 reworded variants, and the 172 near-misses that
  were *not* merged. A duplicate is recoverable; a wrong merge invents a fix.
- **An issue is `fixed` only where a release lists it under Fixed Issues.** AMD also
  silently drops issues from the notes without ever saying they were fixed. Those are
  labelled **"possibly fixed · not listed since X"**, and there is a filter for them.
  The label is deliberately two-sided: the issue may have been fixed without a note, or
  the notes may simply have stopped mentioning it. The release notes cannot tell those
  apart, so this tracker does not pretend to know.
- **The backlog is four issues, not 119.** AMD has not documented a fix for 119 of the 456,
  but it only still *lists* 4 of them — its newest release note carries four known issues.
  The other 115 stopped being listed and are reported separately as "possibly fixed", never
  added to the backlog. The three counts partition the archive exactly: **337 documented
  fixes + 4 still listed + 115 possibly fixed = 456**.
- **Dates before `25.9.2` are month-precision** — 63 of the 80 releases. Those pages carry
  no release date at all, and their JSON-LD `datePublished` is the *page migration* date,
  not the driver date: `24.8.1` reports `2024-11-08` for a driver that shipped in August.
  Those dates are derived from the version number, so the day is always `01`. See
  `meta.date_precision`.
- **The chart counts unfixed issues, not listed ones.** "Issues still unfixed at each
  release" is cumulative: an issue counts from the release that introduced it until one
  documents a fix. So the peak of 119 at `26.9.2` is not AMD's known-issue list, which
  lists four. The bar measures "never documented as fixed" — a different and much larger
  number — and the note under the chart says so.

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

## Recovering releases AMD deleted

AMD removed every release note before 2022, which took RDNA 1 and RDNA 2's launch with
it. The Internet Archive still has them under the old path, and the tooling recovers them:

```bash
python scripts/discover_archived.py --floor 19.7 --below 22.1 \
  --out cache/archived.json

python scripts/backfill.py --manifest cache/releases.json \
  --archived cache/archived.json --out data/tracker.json
```

**This is opt-in, and the shipped archive does not use it.** 55 of the 63 archived releases
were recovered, `19.7.1` → `21.12.1` — RDNA 1's launch and RDNA 2's launch window. It was
taken back out of the default build because it made the site's claims untrue rather than
richer:

- **The recovered range is gappy.** The Archive never captured every 2019-2021 release.
  December 2020 is missing entirely, and so is `20.11.2` — the actual RDNA 2 launch driver,
  the one that added RX 6800 / 6800 XT / 6900 XT support.
- **So nothing in that range can be judged.** An issue last seen there may have been
  relisted and fixed in a release the Archive never had, which turns the "possibly fixed"
  signal from a finding into a guess.
- **And its dates are month-precision**, like the rest of pre-`25.9.2`, so the extra
  releases add bars whose x-positions are approximations.

Widening coverage back to `19.7.1` therefore costs the site its simplest and strongest
claim — that every release AMD publishes is tracked. That trade is deliberate, and one flag
reverses it. `meta.contiguous_from` is what makes reversing it safe: it names the oldest
release from which coverage is complete, and `isStale()` refuses to judge an issue whose
`last_seen` predates it. The UI gates on `contiguous_from` rather than the `contiguous`
flag, so the verified window keeps working even when the window as a whole is gappy.

Four things about the crawl, all learned the hard way:

- **The Archive rate-limits hard.** A full crawl will hit HTTP 429 repeatedly. The script
  fails fast on 429 and paces the whole crawl with an escalating cooldown rather than
  burning retries, but it still takes a while. Snapshots are cached, so a partial crawl
  resumes for free — `--offline` finalises whatever has been collected so far. **The cache
  is gitignored**, so on a fresh clone this means a real crawl, not a re-parse.
- **Wayback replays the stored bytes, including `Content-Encoding: gzip`.** Undecompressed,
  every page looks like a ~16 KB stub of binary noise that parses to zero issues. Both the
  fetch and the backfill decompress on the magic bytes, not the file extension.
- **The recovered pages use an older AMD template**, where `Fixed Issues` and `Known Issues`
  are real headings rather than bold list labels. The shared parser handles both.
- **A crawler you think you killed may still be running.** Twice a surviving process
  overwrote `cache/archived.json` mid-flight — once without the `cache_file` field, so the
  next backfill silently skipped 52 releases. The tell was the merged count changing with
  nothing else touching the manifest. Check the process list, not `pkill`'s exit code.

## Staying current

`.github/workflows/watch.yml` runs `scripts/watch_releases.py` daily. It probes a
narrow window around today — not the whole archive — and if AMD has published a release
we have not logged, it rebuilds the database, validates it, and **publishes it straight to
`main`**, so the site stays current without anyone merging anything.

Publishing unattended only works if something replaces the human check, so
`scripts/check_rebuild.py` compares the rebuild against what is live and refuses anything
that is *impossible* rather than merely uncertain:

- a tracked release disappearing
- an issue that was fixed going back to pending — a newer release note cannot un-document a fix
- coverage flipping from contiguous to gappy
- the issue count shrinking by more than the merges the rebuild recorded

Ordinary churn — new issues, newly documented fixes, merges — passes, so this does not become
a gate that needs babysitting. When the guard does trip, or when the push is rejected, the run
falls back to a pull request, which is exactly the case that wants eyes on it.

**A `GITHUB_TOKEN` push does not trigger other workflows**, so after publishing the run
dispatches `pages.yml` by name. Without that the repository would update and the site would
silently not — which is why `pages.yml` carries `workflow_dispatch`.

```bash
python scripts/watch_releases.py --out .watch/new.json
# exit 0  = up to date
# exit 10 = new releases found
```

The window is anchored to the newest tracked release but is always extended far enough to
reach the current month. Anchoring it to the newest release alone meant a tracker that fell
more than a couple of months behind never probed the present again — it would report "up to
date" forever while the archive quietly froze. `tests/test_watcher.py` pins that, including
that a catch-up window covers every month it spans rather than just the current one.

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

Live at **https://ryusuzaku.github.io/AMDWatch/**.

`.github/workflows/pages.yml` publishes to GitHub Pages on every push to `main`. It
stages only the five files the browser actually fetches — `index.html`, `app.js`,
`style.css`, `lib/` and `data/tracker.json` — so the scripts, schema, tests, workflows
and the `data/review.json` review artifact stay in the repository and off the site. It
refuses to publish if validation or the importer tests fail.

Pages is configured with Source = **GitHub Actions**. All asset paths are relative, so
the `/AMDWatch/` project subpath works without configuration — which is verified, not
assumed: the rendered-page probe runs against a simulated subpath deploy.

`.github/workflows/watch.yml` runs daily and opens a pull request when AMD ships a
release the tracker has not logged, rather than pushing to `main`.

## Known limitations

- **456 issues is an upper bound, not a count of distinct bugs.** 172 near-miss pairs are
  deliberately held apart. The clearest example is Cyberpunk 2077's "intermittent system or
  application crash", which appears as three records as AMD progressively widened the GPU
  scope from unqualified, to RX 7000, to RX 7000 and RX 9000. Whether those are one issue or
  three is a judgement call the threshold cannot make.
- **RDNA 1 and RDNA 2's launch are not covered.** AMD deleted the release notes. The
  Internet Archive has most of them and the tooling recovers them, but the recovered range
  is gappy and cannot be judged, so it is out of the shipped archive. See "Recovering
  releases AMD deleted".
- 237 of the 456 issues have no game in their text and 232 no GPU model, so those fields are
  `Not specified` and derived heuristically for filtering. The issue text is the source of
  truth.
- Dates before `25.9.2` are month-precision — 63 of 80 releases. See `meta.date_precision`.
- The chart windows the archive to 20 releases and scrolls sideways in `All time`. A much
  deeper archive would want a coarser x-axis than "one bar per release" — quarterly buckets,
  say.
- Not built, and worth knowing if you compare this to similar trackers: GPU **launch-period
  bands** on the chart, and an alternate card/timeline layout. Neither is hard; both need
  verified launch-date data, which is the part that takes the care.
- Release-note text is AMD's. The site carries a trademark disclaimer and links every issue
  to its source, and the archive is stored as normalized one-line summaries rather than
  republished pages. The raw HTML stays in a gitignored cache. **This is a judgement call,
  not legal advice** — get it reviewed before the archive grows or is monetized.

## Suggested next steps

1. Work through `data/review.json`: confirm or reject the 34 automatic merges, and decide
   the 172 near-miss pairs. That is the single biggest quality lever left.
2. Record aliases when an issue's wording changes, so identity survives rewording
   without needing a similarity threshold at all.
3. Decide the Cyberpunk-style "same bug, wider scope" question, and encode the rule.
4. Add GPU launch-period bands once the launch dates are verified.
5. If the pre-2022 range is ever wanted back, finish the Archive crawl — 8 of the 63
   archived releases were never captured — and re-enable it with `--archived`.
