#!/usr/bin/env python3
"""Discover which AMD Adrenalin releases still have published release notes.

Three things make this harder than a loop over a URL template:

1. AMD serves its "404 Page Not Found" page with HTTP 200 on some paths and a real
   404 on others, so the status code alone cannot be trusted.
2. Some real release notes have a broken <title> -- 22.3.1's title is literally the
   legacy URL. Classifying on the title alone therefore *rejects valid data*, which
   is worse than missing it. Existence is decided on the "Article Number:
   RN-RAD-WIN-..." marker in the page body, with the title as a fallback.
3. Versions are not dense: AMD skips months and ships multiple patches per month,
   so every candidate has to be probed rather than inferred.

Dates: pages from about 25.9.2 onward carry a "Last Updated" line. Older pages carry
no release date at all, and their JSON-LD `datePublished` is the *page migration*
date (24.8.1 reports 2024-11-08 for a driver that shipped in August), so it must not
be used. Those releases get a month-precision date derived from the version number,
flagged with `date_precision: "month"` rather than passed off as exact.

    python scripts/discover_releases.py --from 22.1 --to 26.12 --out cache/releases.json
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_release_notes import DOMBuilder, text_of  # noqa: E402

BASE = "https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-{}.html"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
ARTICLE_RE = re.compile(r"Article Number\s*:?\s*(RN-RAD-WIN-[0-9A-Za-z-]+)", re.I)
UPDATED_RE = re.compile(
    r"Last Updated\s*:?\s*([A-Za-z]+)\s+(\d{1,2})(?:\s*(?:st|nd|rd|th))?\s*,?\s*(\d{4})", re.I)
MONTHS = {m.lower(): i for i, m in enumerate(
    "January February March April May June July August September October November December".split(), 1)}


def url_for(version):
    return BASE.format(version.replace(".", "-"))


def derive_date(version):
    """Version numbers encode year and month: 24.8.1 -> 2024-08. Day is unknown."""
    try:
        year, month, _ = (int(p) for p in version.split("."))
    except ValueError:
        return None
    if not 1 <= month <= 12:
        return None
    return f"{2000 + year:04d}-{month:02d}-01"


def classify(version, url, html, source):
    m = TITLE_RE.search(html)
    title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    if "404" in title:
        return {"version": version, "url": url, "exists": False, "reason": "soft-404"}

    builder = DOMBuilder()
    builder.feed(html)
    text = text_of(builder.root)

    article = ARTICLE_RE.search(text)
    if not article and "Release Notes" not in title:
        return {"version": version, "url": url, "exists": False,
                "reason": f"no-release-marker:{title[:60]}"}

    rec = {"version": version, "url": url, "exists": True, "title": title, "source": source}
    if article:
        rec["article"] = article.group(1)
    if not title or title.startswith("http"):
        rec["title_broken"] = True
        rec["title"] = f"AMD Software: Adrenalin Edition {version} Release Notes"

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


def probe(version, cache_dir, offline, attempts=3, delay=0.0):
    url = url_for(version)
    cached = None
    if cache_dir:
        cached = os.path.join(cache_dir, re.sub(r"[^A-Za-z0-9._-]+", "_", url) + ".html")
        if os.path.exists(cached):
            with open(cached, encoding="utf-8", errors="replace") as fh:
                return classify(version, url, fh.read(), "cache")

    if offline:
        return {"version": version, "url": url, "exists": False, "reason": "not-cached"}

    last = ""
    for i in range(attempts):
        req = Request(url, headers={"User-Agent": UA})
        try:
            with urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8", "replace")
            if cached:
                os.makedirs(cache_dir, exist_ok=True)
                with open(cached, "w", encoding="utf-8") as fh:
                    fh.write(raw)
            if delay:
                time.sleep(delay)
            return classify(version, url, raw, "net")
        except HTTPError as exc:
            if exc.code == 404:
                if delay:
                    time.sleep(delay)
                return {"version": version, "url": url, "exists": False, "reason": "http-404"}
            last = f"HTTP {exc.code}"
        except (URLError, TimeoutError, OSError) as exc:
            last = type(exc).__name__
        time.sleep(1.0 * (i + 1))
    return {"version": version, "url": url, "exists": False, "reason": f"error:{last}"}


def candidates(start, end, patches):
    (sy, sm), (ey, em) = start, end
    out = []
    for year in range(sy, ey + 1):
        first = sm if year == sy else 1
        last = em if year == ey else 12
        for month in range(first, last + 1):
            for patch in range(1, patches + 1):
                out.append(f"{year}.{month}.{patch}")
    return out


def version_key(item):
    """Sort key for a release record or a bare version string."""
    version = item["version"] if isinstance(item, dict) else item
    return tuple(int(p) for p in version.split("."))


def parse_ym(text):
    y, m = text.split(".")
    return int(y), int(m)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="22.1")
    ap.add_argument("--to", dest="end", default="26.12")
    ap.add_argument("--patches", type=int, default=3)
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--out", default="cache/releases.json")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--delay", type=float, default=0.4)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    todo = candidates(parse_ym(args.start), parse_ym(args.end), args.patches)
    found, missing = [], []
    for n, version in enumerate(todo, 1):
        rec = probe(version, args.cache or None, args.offline, delay=args.delay)
        if rec.get("exists"):
            found.append(rec)
            if not args.quiet:
                flag = " (title repaired)" if rec.get("title_broken") else ""
                print(f"  OK   {version:9} {rec.get('date', '?'):10} "
                      f"{rec.get('date_precision', ''):5} {rec['channel']:11} "
                      f"{rec['title'][:52]}{flag}", flush=True)
        else:
            missing.append({"version": version, "reason": rec.get("reason")})
        if n % 25 == 0 and not args.quiet:
            print(f"  ... {n}/{len(todo)}", flush=True)

    found.sort(key=version_key)
    manifest = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "range": f"{args.start} .. {args.end}",
        "probed": len(todo),
        "found": len(found),
        "releases": found,
        "absent": missing,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    reasons = {}
    for miss in missing:
        reasons[miss["reason"]] = reasons.get(miss["reason"], 0) + 1
    exact = sum(1 for r in found if r.get("date_precision") == "day")
    print(f"\nprobed {len(todo)}, found {len(found)}, absent {len(missing)}")
    print(f"  dates: {exact} exact (from page), {len(found) - exact} month-precision (from version)")
    for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {count:4}  {reason[:80]}")
    print(f"wrote {args.out}")
    if found:
        print(f"range: {found[0]['version']} .. {found[-1]['version']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
