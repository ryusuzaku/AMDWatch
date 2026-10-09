#!/usr/bin/env python3
"""Decide whether a rebuilt tracker may be published without a human reading it.

The scheduled watcher used to open a pull request for every new release, so the tracker
only moved when someone merged it. Publishing straight to main is fine for the ordinary
case -- a new release appends issues and flips some from pending to fixed -- but the
identity step can also merge two records, and a wrong merge invents a fix.

So before publishing, compare the rebuild against what is live and refuse anything that is
*impossible* rather than merely uncertain. Only regressions block:

  - a tracked release disappearing
  - an issue that was fixed going back to pending (a newer note cannot un-document a fix)
  - coverage flipping from contiguous to gappy
  - the issue count shrinking by more than the merges the rebuild recorded

Ordinary churn -- new issues, newly documented fixes, merges -- passes, so this does not
become a gate that needs babysitting. When it does block, the caller falls back to a pull
request, which is exactly the case that wants eyes on it.

    python scripts/check_rebuild.py --before .watch/before.json \
        --after data/tracker.json --review data/review.json
    # exit 0  = ordinary churn, safe to publish
    # exit 20 = needs a human
"""
import argparse
import json
import sys

NEEDS_REVIEW_EXIT = 20


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def check(before, after, review):
    """Return a list of reasons this rebuild must not be published unattended."""
    problems = []

    before_versions = {d["version"] for d in before.get("drivers", [])}
    after_versions = {d["version"] for d in after.get("drivers", [])}
    lost = sorted(before_versions - after_versions)
    if lost:
        shown = ", ".join(lost[:8]) + ("..." if len(lost) > 8 else "")
        problems.append(f"{len(lost)} tracked release(s) disappeared: {shown}")

    # A newer release note can document a fix. It cannot un-document one.
    after_status = {b["text"]: b["status"] for b in after.get("bugs", [])}
    regressed = [b["text"] for b in before.get("bugs", [])
                 if b["status"] == "fixed" and after_status.get(b["text"]) == "pending"]
    if regressed:
        problems.append(
            f"{len(regressed)} issue(s) went from fixed back to pending, e.g. {regressed[0][:70]!r}")

    if before.get("meta", {}).get("contiguous") and not after.get("meta", {}).get("contiguous"):
        problems.append("coverage stopped being contiguous")

    # Adding a release can only append issues or merge existing ones, so a shrink has to be
    # accounted for by a merge the rebuild recorded. An unexplained shrink means records
    # were dropped rather than combined.
    shrink = len(before.get("bugs", [])) - len(after.get("bugs", []))
    merges = len((review or {}).get("fuzzy_merges", []))
    if shrink > merges:
        problems.append(
            f"issue count fell by {shrink} but only {merges} merge(s) were recorded")

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True, help="the tracker that is currently live")
    ap.add_argument("--after", required=True, help="the freshly rebuilt tracker")
    ap.add_argument("--review", default=None, help="review.json from the same rebuild")
    args = ap.parse_args()

    before, after = load(args.before), load(args.after)
    review = load(args.review) if args.review else None

    problems = check(before, after, review)
    print(f"releases {len(before.get('drivers', []))} -> {len(after.get('drivers', []))}, "
          f"issues {len(before.get('bugs', []))} -> {len(after.get('bugs', []))}")

    if problems:
        print("\nthis rebuild is not ordinary churn and needs a human:")
        for problem in problems:
            print(f"  - {problem}")
        return NEEDS_REVIEW_EXIT

    print("ordinary churn; safe to publish")
    return 0


if __name__ == "__main__":
    sys.exit(main())
