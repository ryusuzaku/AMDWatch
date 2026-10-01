#!/usr/bin/env python3
"""Build the whole tracker from the cached release notes.

Reads the manifest produced by discover_releases.py, parses every cached release
note with the same parser the single-release importer uses, and stitches the issues
into one history.

Issue identity is the whole problem. AMD copy-pastes a bullet verbatim from release
to release for a carried-over known issue, so exact normalized-text equality catches
most of it. What it does not catch is an issue that gets reworded when it moves from
Known Issues to Fixed Issues. Those are matched fuzzily, but *only* above a high
threshold, and every fuzzy merge is written to the review file. A wrong merge is
worse than a duplicate: it invents a fix that never happened.

This script is not a replacement for review. It is the thing that makes review
tractable: it produces the history and tells you exactly which decisions it made
that a human should confirm.

    python scripts/backfill.py --manifest cache/releases.json --out data/tracker.json
"""
import argparse
import collections
import difflib
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_release_notes import extract  # noqa: E402

CACHE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
SERIES = ("5000", "6000", "7000", "8000", "9000")


def cache_path(cache_dir, url):
    return os.path.join(cache_dir, CACHE_NAME_RE.sub("_", url) + ".html")


def version_key(version):
    return tuple(int(p) for p in version.split("."))


# --------------------------------------------------------------- field derivation

GPU_RE = re.compile(r"\bRX\s?(\d{4})(?:\s?(XTX|XT|GRE))?", re.I)
RYZEN_RE = re.compile(r"\bRyzen\s+AI\s+\d+\s+\w+", re.I)
GAME_PATTERNS = [
    re.compile(r"while\s+playing\s+(?:a\s+)?(.+?)(?:\s+(?:on|with|in|at)\s|,\s|\.\s*$)", re.I),
    re.compile(r"when\s+playing\s+(?:a\s+)?(.+?)(?:\s+(?:on|with|in|at)\s|,\s|\.\s*$)", re.I),
    re.compile(r"while\s+launching\s+(?:a\s+)?(.+?)(?:\s+(?:on|with|in|at)\s|,\s|\.\s*$)", re.I),
    re.compile(r"\bplaying\s+([A-Z][^,.]+?)\s+(?:with|on|in)\s", re.I),
    re.compile(r"\bin\s+([A-Z][^,.]+?)\s+(?:with|on|while|when)\s", re.I),
]
GENERIC_GAME = re.compile(r"^(a |the )?(saved game|game|application|system|video|stream)$", re.I)


def derive_gpu(text):
    seen = []
    for m in GPU_RE.finditer(text):
        model = f"RX {m.group(1)}"
        suffix = (m.group(2) or "").upper()
        if suffix:
            model = f"{model} {suffix}"
        if model not in seen:
            seen.append(model)
    if seen:
        return " / ".join(seen)
    m = RYZEN_RE.search(text)
    if m:
        return m.group(0)
    return "Not specified"


def derive_game(text):
    for pattern in GAME_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        candidate = m.group(1).strip(" .,:;")
        if not candidate or GENERIC_GAME.match(candidate) or len(candidate) < 3:
            continue
        return candidate[:80]
    return "Not specified"


# ------------------------------------------------------------------ issue identity

class IssueIndex:
    """Groups candidate lines into issues, and records every fuzzy decision."""

    def __init__(self, threshold, review_threshold):
        self.issues = []
        self.by_key = {}
        self.word_index = collections.defaultdict(set)
        self.threshold = threshold
        self.review_threshold = review_threshold
        self.fuzzy_merges = []
        self.near_misses = []

    @staticmethod
    def _words(key):
        return {w for w in key.split() if len(w) >= 4}

    def _candidates_for(self, key):
        out = set()
        for word in self._words(key):
            out |= self.word_index.get(word, set())
        return out

    def find(self, key):
        """Return (issue_index or None, best_index, best_ratio)."""
        exact = self.by_key.get(key)
        if exact is not None:
            return exact, exact, 1.0

        best, best_ratio = None, 0.0
        for i in self._candidates_for(key):
            ratio = difflib.SequenceMatcher(None, key, self.issues[i]["match_key"]).ratio()
            if ratio > best_ratio:
                best, best_ratio = i, ratio

        if best is not None and best_ratio >= self.threshold:
            return best, best, best_ratio
        return None, best, best_ratio

    def add(self, cand, release_idx, version):
        key = cand["match_key"]
        idx, best, ratio = self.find(key)

        if idx is None:
            idx = len(self.issues)
            self.issues.append({
                "match_key": key,
                "text": cand["text"],
                "first_idx": release_idx,
                "last_idx": release_idx,
                "fixed_idx": release_idx if cand["kind"] == "fixed" else None,
                "sources_idx": {release_idx},
                "variants": {cand["text"]},
                "kinds": {cand["kind"]},
            })
            for word in self._words(key):
                self.word_index[word].add(idx)
            if best is not None and ratio >= self.review_threshold:
                self.near_misses.append({
                    "new": cand["text"], "closest": self.issues[best]["text"],
                    "similarity": round(ratio, 3), "version": version,
                })
            return idx, ratio

        issue = self.issues[idx]
        issue["last_idx"] = max(issue["last_idx"], release_idx)
        issue["sources_idx"].add(release_idx)
        issue["variants"].add(cand["text"])
        issue["kinds"].add(cand["kind"])
        if cand["kind"] == "fixed" and issue["fixed_idx"] is None:
            issue["fixed_idx"] = release_idx
        if ratio < 1.0:
            self.fuzzy_merges.append({
                "version": version, "incoming": cand["text"],
                "matched": issue["text"], "similarity": round(ratio, 3),
            })
        return idx, ratio


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="cache/releases.json")
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--out", default="data/tracker.json")
    ap.add_argument("--review-out", default="data/review.json")
    ap.add_argument("--threshold", type=float, default=0.95,
                    help="similarity at or above which two lines are the same issue")
    ap.add_argument("--review-threshold", type=float, default=0.72)
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as fh:
        manifest = json.load(fh)
    releases = sorted(manifest["releases"], key=lambda r: version_key(r["version"]))

    index = IssueIndex(args.threshold, args.review_threshold)
    parsed, skipped = [], []
    for release_idx, rel in enumerate(releases):
        path = cache_path(args.cache, rel["url"])
        if not os.path.exists(path):
            skipped.append({"version": rel["version"], "reason": "no cached page"})
            continue
        with open(path, encoding="utf-8", errors="replace") as fh:
            html = fh.read()
        result = extract(html, rel["version"], rel.get("date", ""), rel["url"])
        parsed.append((rel, result))
        for cand in result["candidates"]:
            index.add(cand, release_idx, rel["version"])

    def ver(i):
        return releases[i]["version"]

    issues = sorted(index.issues, key=lambda x: (x["first_idx"], x["text"]))

    bugs = []
    for n, issue in enumerate(issues, 1):
        fixed_idx = issue["fixed_idx"]
        sources = sorted(issue["sources_idx"], key=lambda i: version_key(ver(i)))
        bugs.append({
            "id": f"AMD-{n:04d}",
            "text": issue["text"],
            "first": ver(issue["first_idx"]),
            "last_seen": ver(issue["last_idx"]),
            "status": "fixed" if fixed_idx is not None else "pending",
            "fixed_in": ver(fixed_idx) if fixed_idx is not None else None,
            "game": derive_game(issue["text"]),
            "gpu": derive_gpu(issue["text"]),
            "sources": [ver(i) for i in sources],
        })

    drivers_oldest_first = [{
        "version": rel["version"],
        "date": rel.get("date") or f"{2000 + int(rel['version'].split('.')[0]):04d}-"
                                   f"{int(rel['version'].split('.')[1]):02d}-01",
        "channel": rel.get("channel", "Adrenalin"),
        "url": rel["url"],
    } for rel in releases]
    # The data file stores drivers newest-first. The validator enforces it, and
    # indexDrivers no longer depends on it, so keep the file consistent anyway.
    drivers = list(reversed(drivers_oldest_first))
    oldest, newest = drivers_oldest_first[0]["version"], drivers_oldest_first[-1]["version"]

    month_precision = sum(1 for r in releases if r.get("date_precision") == "month")
    data = {
        "drivers": drivers,
        "bugs": bugs,
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "last_checked": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "coverage": f"Every AMD Adrenalin release note still published by AMD, "
                        f"{oldest} to {newest}.",
            "coverage_from": oldest,
            "coverage_to": newest,
            "contiguous": True,
            "contiguity_basis": "Every version in the probed window was either found "
                                "and included, or confirmed absent (HTTP 404) by "
                                "scripts/discover_releases.py.",
            "date_precision": {
                "exact": len(releases) - month_precision,
                "month": month_precision,
                "note": "Pages from 25.9.2 onward state a release date. Older pages "
                        "carry no date, and their JSON-LD datePublished is the page "
                        "migration date rather than the driver date, so those dates "
                        "are derived from the version number and are month-accurate "
                        "only (day is set to 01).",
            },
            "method": "Parsed from AMD release notes by scripts/backfill.py. An issue is "
                      "fixed only where a release lists it under Fixed Issues. Fuzzy "
                      "issue merges above similarity 0.95 are automatic and logged; "
                      "everything else is a separate record.",
            "source": "AMD official release notes",
        },
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    # newline="\n": without it Windows writes CRLF, which fights .gitattributes and
    # makes the file churn against anything generated on Linux (e.g. the watcher CI).
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    review = {
        "generated": data["meta"]["generated"],
        "thresholds": {"merge": args.threshold, "report": args.review_threshold},
        "summary": {
            "releases": len(drivers),
            "candidates_parsed": sum(len(r["candidates"]) for _, r in parsed),
            "issues": len(bugs),
            "pending": sum(1 for b in bugs if b["status"] == "pending"),
            "fixed": sum(1 for b in bugs if b["status"] == "fixed"),
            "fuzzy_merges": len(index.fuzzy_merges),
            "near_misses_not_merged": len(index.near_misses),
            "issues_with_reworded_variants": sum(1 for i in issues if len(i["variants"]) > 1),
        },
        "fuzzy_merges": index.fuzzy_merges,
        "near_misses_not_merged": index.near_misses,
        "reworded": [{"text": i["text"], "variants": sorted(i["variants"])}
                     for i in issues if len(i["variants"]) > 1],
        "skipped": skipped,
    }
    os.makedirs(os.path.dirname(args.review_out) or ".", exist_ok=True)
    with open(args.review_out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(review, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    s = review["summary"]
    print(f"releases parsed     {len(parsed)}/{len(releases)}")
    print(f"candidate lines     {s['candidates_parsed']}")
    print(f"distinct issues     {s['issues']}  ({s['pending']} pending, {s['fixed']} fixed)")
    print(f"fuzzy merges        {s['fuzzy_merges']}  (similarity >= {args.threshold})")
    print(f"reworded variants   {s['issues_with_reworded_variants']}")
    print(f"near misses kept    {s['near_misses_not_merged']}  (not merged, for review)")
    if skipped:
        print(f"skipped             {len(skipped)}")
    print(f"wrote {args.out} and {args.review_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
