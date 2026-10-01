#!/usr/bin/env python3
"""Watch for AMD driver releases that this tracker has not logged yet.

This is the scheduled half of the project. It probes a narrow window around the
current date, compares what exists against what data/tracker.json already tracks,
and writes a report. It does not modify the tracker: deciding that a new release
belongs in the database is a review step, and a human or a pull request does it.

A full re-scan is deliberately avoided -- discover_releases.py probes ~300 candidate
versions, which is fine once and rude daily. This probes a few dozen.

    python scripts/watch_releases.py --out .watch/new.json
    # exit 0 = up to date, exit 10 = new releases found
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from discover_releases import probe, version_key  # noqa: E402

NEW_RELEASES_EXIT = 10


def load_tracked(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return {d["version"] for d in data.get("drivers", [])}


def newest_tracked(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    versions = [d["version"] for d in data.get("drivers", [])]
    return max(versions, key=version_key) if versions else None


def window(start_version, now, lookahead_months, patches):
    """Candidate versions from the newest tracked release through the near future."""
    year, month, _ = (int(p) for p in start_version.split("."))
    yy = year % 100
    out = []
    for step in range(-1, lookahead_months + 1):
        m = month + step
        y = year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        for patch in range(1, patches + 1):
            v = f"{y % 100}.{m}.{patch}"
            # Only look forward from the newest tracked release.
            if version_key(v) >= version_key(start_version):
                out.append(v)
    if now is not None:
        out = [v for v in out if version_key(v) <= (now.year % 100, now.month + 1, 9)]
    return sorted(set(out), key=version_key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracker", default="data/tracker.json")
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--out", default=".watch/new.json")
    ap.add_argument("--lookahead-months", type=int, default=2)
    ap.add_argument("--patches", type=int, default=5)
    ap.add_argument("--delay", type=float, default=0.4)
    args = ap.parse_args()

    tracked = load_tracked(args.tracker)
    newest = newest_tracked(args.tracker)
    if not newest:
        sys.exit(f"{args.tracker} has no drivers to start from")

    now = datetime.now(timezone.utc)
    todo = window(newest, now, args.lookahead_months, args.patches)
    print(f"newest tracked: {newest}; probing {len(todo)} candidate version(s)")

    found, new = [], []
    for version in todo:
        rec = probe(version, args.cache or None, False, delay=args.delay)
        if not rec.get("exists"):
            continue
        found.append(rec)
        if version not in tracked:
            new.append(rec)
            print(f"  NEW  {version:9} {rec.get('date', '?')} {rec['channel']}")

    report = {
        "checked_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tracker_newest": newest,
        "probed": len(todo),
        "existing": [r["version"] for r in found],
        "new": new,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    if new:
        print(f"\n{len(new)} new release(s): {', '.join(r['version'] for r in new)}")
        print(f"wrote {args.out}")
        return NEW_RELEASES_EXIT
    print(f"\nup to date; {len(found)} release(s) probed all already tracked")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
