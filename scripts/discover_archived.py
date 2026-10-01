#!/usr/bin/env python3
"""Recover AMD release notes that AMD itself no longer publishes, via the Wayback Machine.

AMD deleted every release note before 2022. RDNA 1 (July 2019) and RDNA 2's launch
(November 2020) are therefore missing from amd.com entirely. The Internet Archive has
them, under the old /en/support/kb/release-notes/rn-rad-win-* path.

Three things this has to get right:

1. The archived pages use the *older* AMD template, where `Fixed Issues` and `Known
   Issues` are real headings rather than bold list labels. The shared parser handles
   both; nothing special is needed here.
2. Wayback serves the stored response byte-for-byte, including its original
   `Content-Encoding: gzip`. Decompressing is mandatory or every page looks like a
   ~16 KB stub of binary noise.
3. The archived set is **not complete**. AMD shipped more releases in 2019-2021 than
   the Archive captured, so this window is best-effort and must not be presented as
   contiguous. That is recorded in the output and enforced downstream.

    python scripts/discover_archived.py --floor 19.7 --out cache/archived.json
"""
import argparse
import gzip
import json
import os
import re
import sys
import time
import zlib
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_release_notes import DOMBuilder, text_of  # noqa: E402

CDX = ("https://web.archive.org/cdx/search/cdx"
       "?url=amd.com/en/support/kb/release-notes/rn-rad-win-*"
       "&collapse=urlkey&fl=original,timestamp,statuscode&limit=2000")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

VERSION_RE = re.compile(r"rn-rad-win-(\d{2})-(\d{1,2})-(\d{1,2})$")
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
ARTICLE_RE = re.compile(r"Article Number\s*:?\s*(RN-RAD-WIN-[0-9A-Za-z-]+)", re.I)
UPDATED_RE = re.compile(
    r"Last Updated\s*:?\s*([A-Za-z]+)\s+(\d{1,2})(?:\s*(?:st|nd|rd|th))?\s*,?\s*(\d{4})", re.I)
MONTHS = {m.lower(): i for i, m in enumerate(
    "January February March April May June July August September October November December".split(), 1)}


def version_key(version):
    return tuple(int(p) for p in version.split("."))


def derive_date(version):
    try:
        year, month, _ = (int(p) for p in version.split("."))
    except ValueError:
        return None
    if not 1 <= month <= 12:
        return None
    return f"{2000 + year:04d}-{month:02d}-01"


def list_snapshots(delay=2.0, attempts=4):
    """Ask the CDX index which release notes exist, newest capture per URL."""
    for i in range(attempts):
        try:
            req = Request(CDX, headers={"User-Agent": UA})
            with urlopen(req, timeout=120) as resp:
                body = resp.read()
            if body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            text = body.decode("utf-8", "replace")
            if "Too Many Requests" in text[:400]:
                raise HTTPError(CDX, 429, "rate limited", {}, None)
            rows = []
            for line in text.splitlines():
                parts = line.split()
                if len(parts) < 3 or parts[2] != "200":
                    continue
                m = VERSION_RE.search(parts[0])
                if not m:
                    continue
                version = f"{int(m.group(1))}.{int(m.group(2))}.{int(m.group(3))}"
                rows.append({"version": version, "snapshot": parts[1], "original": parts[0]})
            return rows
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            code = getattr(exc, "code", None)
            wait = delay * (i + 1) * (3 if code == 429 else 1)
            print(f"  cdx attempt {i + 1} failed ({exc}); waiting {wait:.0f}s", flush=True)
            time.sleep(wait)
    raise SystemExit("could not reach the Wayback CDX index")


def cache_name(snapshot, original):
    """Stable cache filename for one archived snapshot."""
    return f"{snapshot}_{re.sub(r'[^A-Za-z0-9]+', '_', original)[-60:]}.html"


def fetch(snapshot, original, cache_dir, attempts=4, delay=1.5, offline=False):
    """Fetch one archived snapshot, decompressed. Returns (bytes, archive_url, how, path)."""
    archive_url = f"https://web.archive.org/web/{snapshot}id_/{original}"
    cached = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        cached = os.path.join(cache_dir, cache_name(snapshot, original))
        if os.path.exists(cached):
            with open(cached, "rb") as fh:
                return decompress(fh.read()), archive_url, "cache", cached
    if offline:
        return None, archive_url, "not-cached", cached

    last = ""
    for i in range(attempts):
        try:
            req = Request(archive_url, headers={"User-Agent": UA})
            with urlopen(req, timeout=90) as resp:
                raw = resp.read()
            raw = decompress(raw)
            if cached:
                with open(cached, "wb") as fh:
                    fh.write(gzip.compress(raw))
            time.sleep(delay)
            return raw, archive_url, "net", cached
        except HTTPError as exc:
            if exc.code == 429:
                # Fail fast rather than burning retries: a 429 means the Archive is
                # throttling this client, so backing off inside one request does nothing.
                # The caller paces the whole crawl instead.
                return None, archive_url, "rate-limited", cached
            if exc.code in (404, 403):
                return None, archive_url, f"HTTP {exc.code}", cached
            last = f"HTTP {exc.code}"
            time.sleep(delay * (i + 1))
        except (URLError, TimeoutError, OSError) as exc:
            last = type(exc).__name__
            time.sleep(delay * (i + 1))
    return None, archive_url, f"error:{last}", cached


def decompress(raw):
    """Wayback replays the stored bytes, so gzip arrives un-decoded."""
    if raw[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(raw)
        except OSError:
            pass
    # Some captures are stored with a raw deflate stream instead.
    try:
        return zlib.decompress(raw, -zlib.MAX_WBITS)
    except zlib.error:
        return raw


def classify(version, html, archive_url, original, snapshot):
    m = TITLE_RE.search(html)
    title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    if "404" in title or not title:
        return None

    builder = DOMBuilder()
    builder.feed(html)
    text = text_of(builder.root)

    if not ARTICLE_RE.search(text) and "Release Notes" not in title:
        return None

    rec = {
        "version": version,
        "url": archive_url,
        "original_url": original,
        "source": "wayback",
        "snapshot": snapshot,
        "exists": True,
        "title": title,
        "archived": True,
    }

    d = UPDATED_RE.search(text)
    if d and MONTHS.get(d.group(1).lower()):
        rec["date"] = f"{d.group(3)}-{MONTHS[d.group(1).lower()]:02d}-{int(d.group(2)):02d}"
        rec["date_precision"] = "day"
        rec["date_source"] = "page"
    else:
        derived = derive_date(version)
        if derived:
            rec["date"] = derived
            rec["date_precision"] = "month"
            rec["date_source"] = "version"

    low = (title + " " + text[:400]).lower()
    if "whql" in low:
        rec["channel"] = "WHQL"
    elif "optional" in low:
        rec["channel"] = "Optional"
    elif "recommended" in low:
        rec["channel"] = "Recommended"
    else:
        rec["channel"] = "Adrenalin"
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", default="19.7", help="oldest version to keep (RDNA 1 is 19.7)")
    ap.add_argument("--below", default="22.1",
                    help="newest version to keep, exclusive. AMD still publishes 22.1.1 "
                         "onward, so recovering those from the Archive is wasted work.")
    ap.add_argument("--cache", default="cache/wayback")
    ap.add_argument("--out", default="cache/archived.json")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--offline", action="store_true",
                    help="Only use cached snapshots. The Archive rate-limits hard, so a "
                         "partial crawl can be finalised now and resumed later.")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    fy, fm = (int(p) for p in args.floor.split("."))
    floor = (fy, fm, 0)
    cy, cm = (int(p) for p in args.below.split("."))
    ceiling = (cy, cm, 0)

    print("asking the Wayback CDX index…", flush=True)
    snaps = list_snapshots(delay=max(2.0, args.delay))
    print(f"  {len(snaps)} archived release-note URL(s)")

    # One snapshot per version, newest capture preferred.
    best = {}
    for s in snaps:
        vk = version_key(s["version"])
        if vk < floor or vk >= ceiling:
            continue
        if s["version"] not in best or s["snapshot"] > best[s["version"]]["snapshot"]:
            best[s["version"]] = s

    todo = sorted(best.values(), key=lambda s: version_key(s["version"]))
    print(f"  {len(todo)} between {args.floor} and {args.below}, fetching…", flush=True)

    found, rejected = [], []
    cooldown = 0
    for n, s in enumerate(todo, 1):
        if cooldown:
            if not args.quiet:
                print(f"  … cooling down {cooldown}s after rate limiting", flush=True)
            time.sleep(cooldown)
        raw, archive_url, how, cached = fetch(s["snapshot"], s["original"], args.cache, delay=args.delay, offline=args.offline)
        if how == "rate-limited":
            # Escalate the pause until the Archive lets us back in, then retry this one.
            cooldown = min(600, (cooldown or 30) * 2)
            raw, archive_url, how, cached = fetch(
                s["snapshot"], s["original"], args.cache, delay=args.delay, offline=args.offline)
        if raw is None:
            rejected.append({"version": s["version"], "reason": how})
            continue
        cooldown = max(0, cooldown // 2)
        rec = classify(s["version"], raw.decode("utf-8", "replace"),
                       archive_url, s["original"], s["snapshot"])
        if rec:
            # Record where the page lives so the backfill does not have to re-derive
            # this naming scheme.
            if cached:
                rec["cache_file"] = cached.replace(os.sep, "/")
            found.append(rec)
            if not args.quiet:
                print(f"  OK   {s['version']:9} {rec.get('date', '?')} "
                      f"{rec.get('date_precision', ''):5} {rec['channel']:11} "
                      f"{rec['title'][:46]}", flush=True)
        else:
            rejected.append({"version": s["version"], "reason": "not a release note"})
        if n % 20 == 0 and not args.quiet:
            print(f"  ... {n}/{len(todo)}", flush=True)

    found.sort(key=lambda r: version_key(r["version"]))
    manifest = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "web.archive.org",
        "floor": args.floor,
        "probed": len(todo),
        "found": len(found),
        "releases": found,
        "rejected": rejected,
        "completeness": (
            "Best effort. The Internet Archive did not capture every release in this "
            "window, so this range must not be treated as contiguous."
        ),
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    years = {}
    for r in found:
        years[r["version"].split(".")[0]] = years.get(r["version"].split(".")[0], 0) + 1
    print(f"\nrecovered {len(found)}/{len(todo)}; rejected {len(rejected)}")
    print(f"  by year: {dict(sorted(years.items()))}")
    print(f"wrote {args.out}")
    if found:
        print(f"range: {found[0]['version']} .. {found[-1]['version']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
