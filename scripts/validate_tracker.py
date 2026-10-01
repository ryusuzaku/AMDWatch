#!/usr/bin/env python3
"""Validate data/tracker.json.

Checks the semantic invariants a JSON Schema cannot express: cross-references
between bugs and drivers, chronological ordering, status/fixed_in agreement,
and duplicate issue text. Exits non-zero on any error so CI can gate on it.

    python scripts/validate_tracker.py [path]
"""
import json
import os
import re
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_release_notes import match_key  # noqa: E402  (shared normalisation)

DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "tracker.json")
ID_RE = re.compile(r"^AMD-\d{4}$")
VERSION_RE = re.compile(r"^\d{2}\.\d{1,2}\.\d{1,2}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CHANNELS = {"Adrenalin", "Optional", "Recommended", "WHQL"}


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def error(self, where, msg):
        self.errors.append(f"{where}: {msg}")

    def warn(self, where, msg):
        self.warnings.append(f"{where}: {msg}")


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def check_drivers(drivers, rep):
    if not isinstance(drivers, list) or not drivers:
        rep.error("drivers", "must be a non-empty list")
        return {}, []

    seen = {}
    dated = []
    for i, d in enumerate(drivers):
        where = f"drivers[{i}]"
        if not isinstance(d, dict):
            rep.error(where, "not an object")
            continue
        for field in ("version", "date", "channel", "url"):
            if not d.get(field):
                rep.error(where, f"missing {field}")
        version = d.get("version", "")
        if version and not VERSION_RE.match(version):
            rep.error(where, f"version {version!r} is not N.N.N")
        if version in seen:
            rep.error(where, f"duplicate version {version}")
        seen[version] = d

        if d.get("channel") and d["channel"] not in CHANNELS:
            rep.error(where, f"unknown channel {d['channel']!r}")

        url = d.get("url", "")
        if url and not url.startswith("https://"):
            rep.error(where, "url must be https")

        parsed = parse_date(d.get("date", ""))
        if d.get("date") and parsed is None:
            rep.error(where, f"date {d['date']!r} is not YYYY-MM-DD")
        if parsed:
            dated.append((parsed, version))

    for a, b in zip(dated, dated[1:]):
        if a[0] < b[0]:
            rep.error("drivers", f"{a[1]} ({a[0]}) is listed before newer {b[1]} ({b[0]})")

    return seen, dated


def check_bugs(bugs, versions, rep):
    """`versions` must be the ordered list of driver versions, newest first."""
    if not isinstance(bugs, list) or not bugs:
        rep.error("bugs", "must be a non-empty list")
        return

    order = {v: n for n, v in enumerate(versions)}
    known = set(order)
    seen_ids = {}
    seen_keys = {}
    for i, b in enumerate(bugs):
        where = f"bugs[{i}]"
        if not isinstance(b, dict):
            rep.error(where, "not an object")
            continue
        bug_id = b.get("id", "")
        where = f"bugs[{i}] ({bug_id or 'no id'})"

        for field in ("id", "text", "first", "last_seen", "status", "game", "gpu", "sources"):
            if field not in b:
                rep.error(where, f"missing {field}")

        if bug_id and not ID_RE.match(bug_id):
            rep.error(where, "id must match AMD-NNNN")
        if bug_id in seen_ids:
            rep.error(where, f"duplicate id, already used by bugs[{seen_ids[bug_id]}]")
        seen_ids[bug_id] = i

        status = b.get("status")
        if status not in ("pending", "fixed"):
            rep.error(where, f"status {status!r} must be 'pending' or 'fixed'")

        for field in ("first", "last_seen"):
            v = b.get(field)
            if v and v not in known:
                rep.error(where, f"{field}={v!r} is not a tracked driver version")

        fixed_in = b.get("fixed_in")
        if status == "fixed":
            if not fixed_in:
                rep.error(where, "status is fixed but fixed_in is empty")
            elif fixed_in not in known:
                rep.error(where, f"fixed_in={fixed_in!r} is not a tracked driver version")
        elif status == "pending" and fixed_in:
            rep.error(where, f"status is pending but fixed_in={fixed_in!r}")

        # `order` is indexed newest-first, so a larger index means an older release.
        first, last = b.get("first"), b.get("last_seen")
        if first in order and last in order and order[last] > order[first]:
            rep.error(where, f"last_seen={last} is older than first={first}")
        if fixed_in in order and first in order and order[fixed_in] > order[first]:
            rep.error(where, f"fixed_in={fixed_in} is older than first={first}")

        sources = b.get("sources")
        if not isinstance(sources, list) or not sources:
            rep.error(where, "sources must be a non-empty list")
        else:
            for s in sources:
                if s not in known:
                    rep.error(where, f"sources contains unknown version {s!r}")
            if first and first not in sources:
                rep.error(where, f"sources is missing first={first}")
            if last and last not in sources:
                rep.error(where, f"sources is missing last_seen={last}")
            if fixed_in and fixed_in not in sources:
                rep.error(where, f"sources is missing fixed_in={fixed_in}")
            if len(set(sources)) != len(sources):
                rep.error(where, "sources contains duplicates")

        text = b.get("text", "")
        if isinstance(text, str):
            if len(text) < 25:
                rep.warn(where, f"text is only {len(text)} characters")
            for bad, name in (("\u2122", "trademark"), ("\u00ae", "registered"), ("Adrenalin Edition", "channel suffix")):
                if bad in text:
                    rep.error(where, f"text is not normalized: contains {name} {bad!r}")
            key = match_key(text)
            if key in seen_keys:
                rep.error(where, f"text duplicates bugs[{seen_keys[key]}] after normalization")
            seen_keys[key] = i


def check_meta(meta, rep):
    if not isinstance(meta, dict):
        rep.error("meta", "must be an object")
        return
    for field in ("generated", "coverage", "method"):
        if not meta.get(field):
            rep.error("meta", f"missing {field}")
    if meta.get("generated") and not DATE_RE.match(meta["generated"]):
        rep.error("meta", f"generated {meta['generated']!r} is not YYYY-MM-DD")
    if meta.get("generated") and parse_date(meta["generated"]) is None:
        rep.error("meta", f"generated {meta['generated']!r} is not a real date")


def validate(path):
    rep = Report()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print(f"FAIL  cannot read {path}: {exc}")
        return 1
    except ValueError as exc:
        print(f"FAIL  {path} is not valid JSON: {exc}")
        return 1

    for field in ("drivers", "bugs", "meta"):
        if field not in data:
            rep.error("root", f"missing {field}")
    if rep.errors:
        for e in rep.errors:
            print(f"FAIL  {e}")
        return 1

    versions, dated = check_drivers(data["drivers"], rep)
    ordered = [v for _, v in dated]
    check_bugs(data["bugs"], ordered, rep)
    check_meta(data["meta"], rep)

    covered = {b.get("first") for b in data["bugs"] if isinstance(b, dict)}
    for v in ordered:
        if v not in covered:
            rep.warn("drivers", f"{v} has no issues recorded against it")

    for w in rep.warnings:
        print(f"warn  {w}")
    for e in rep.errors:
        print(f"FAIL  {e}")

    if rep.errors:
        print(f"\n{len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")
        return 1
    print(f"ok    {path}: {len(data['drivers'])} drivers, {len(data['bugs'])} bugs, "
          f"{len(rep.warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    sys.exit(validate(os.path.normpath(target)))
