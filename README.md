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
- `scripts/import_release_notes.py` — reads an AMD release-note page and emits
  candidates plus match hints against the existing database
- `scripts/validate_tracker.py` — enforces the database invariants
- `schema/tracker.schema.json` — the record shape, for editors
- `scripts/probe_page.mjs` — drives the real page in headless Chromium and asserts
  what a reader would actually see

## Data status

The 27 issue records are a starter sample manually transcribed from selected AMD
release notes. **This is not a complete historical archive.**

- Coverage: `24.8.1` → `26.9.2`, six releases, non-contiguous
- `26.9.2` has been re-checked against the live release note and is complete: all
  four Fixed Issues and all four Known Issues are recorded. The other five
  releases have not been re-checked and may be missing issues.
- `meta.contiguous` is `false`. Until that flips to `true`, the UI deliberately
  does not claim an issue was dropped from the notes, because it may have been
  fixed in a release this tracker does not have.
- A status is marked `fixed` only where a later official release explicitly lists
  the matching issue as fixed, or where it appears under Fixed Issues in its first
  sampled appearance. Matching is reviewed by hand.

Two issues were added on 2026-10-01 from a reviewed import of `26.9.2`
(`AMD-0026`, `AMD-0027`). Re-importing that release now matches all four of its
Known Issues at a normalized-text similarity of `1.0`, which is the round-trip the
importer is designed around.

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

## Validating

```bash
python scripts/validate_tracker.py
```

Checks what a JSON Schema cannot: unique IDs, every `first` / `last_seen` /
`fixed_in` / `sources` value resolving to a tracked driver, `fixed` implying a
`fixed_in`, chronological ordering, `sources` covering the endpoints, normalized
text, and duplicate issue text. Exits non-zero so CI can gate on it.

## Tests

```bash
python -m unittest discover -s tests -t .   # importer and data invariants
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

- Coverage is sparse, so the "open at each release" series can overstate how long
  an issue stayed open. See `meta.contiguous` above.
- Issue identity across wording changes is manual. The importer proposes matches
  by normalized-text similarity; a human accepts or rejects them.
- The chart shows at most twelve release labels before thinning them, but a
  backfill of dozens of releases will need a coarser x-axis than "one bar per
  release".
- Release-note text is AMD's. The site carries a trademark disclaimer and links
  every issue to its source. Review the licensing position before a large backfill.

## Suggested next steps

1. Backfill releases back through older Adrenalin versions, with review.
2. Record aliases when an issue's wording changes, so identity survives rewording.
3. Flip `meta.contiguous` to `true` once the window is unbroken — this turns on
   the "no longer listed" signal.
4. Add a scheduled job that checks the newest release note and opens a PR with a
   candidates diff.
