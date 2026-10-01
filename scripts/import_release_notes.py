#!/usr/bin/env python3
"""Extract candidate issue bullets from an AMD release-note page for human review.

This script never merges, never assigns IDs and never decides that two differently
worded lines describe the same issue. It produces a draft plus match hints, and a
human confirms the result.

Structure of an AMD release-notes page (verified against RN-RAD-WIN-26-9-2):

    <nav>...<a href="#Known_Issues" class="nav-link anchor-bar-link">Known Issues</a>...</nav>
    <h2><a id="Highlights"></a>Highlights</h2>
    <ul>
      <li><b>New Game Support</b><ul><li>Minecraft Dungeons II</li>...</ul></li>
      <li><b>Fixed Issues</b><ul><li>Intermittent driver timeout...</li>...</ul></li>
    </ul>
    <h2><a id="Known_Issues"></a>Known Issues</h2>
    <ul><li>Failure to install...</li>...</ul>

Two things follow from that, and both were wrong in the first version of this script:

1. The anchor bar repeats every section name as a navigation link. Matching a section
   by "a line of text equal to the heading" therefore latches onto the nav link, not the
   heading, and sweeps the whole page body. Sections must be read from h1-h4 elements,
   and nav subtrees must be ignored.
2. "Fixed Issues" is not a heading on these pages. It is a bold label inside a list item,
   followed by a nested list. List groups are therefore part of the document structure,
   not decoration.
"""
import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.request import Request, urlopen

# AMD's CDN does not reject a bot user agent with an HTTP error - it accepts the
# connection and then never sends a body. Measured on 2026-10-01 against
# RN-RAD-WIN-26-9-2: a self-identifying UA times out at 20s on every attempt, a
# browser UA returns 167 KB in 0.3s. Retrying does not help; the UA must change.
# This is a courtesy header for a low-volume, rate-limited reader, not evasion.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
AUTO_CLOSE = {"li", "p", "tr", "td", "th", "option", "dt", "dd"}
HEADING_TAGS = ("h1", "h2", "h3", "h4")

# Subtrees that never contain release-note content.
NOISE_TAGS = {"script", "style", "noscript", "nav", "svg", "form", "button", "select"}
# Elements that look like navigation even when not wrapped in <nav>.
NOISE_CLASS = re.compile(
    r"nav-link|anchor-bar|breadcrumb|skip-link|sidebar|\btoc\b|social|share", re.I
)


# --------------------------------------------------------------------------- DOM

class Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = attrs
        self.children = []

    def elements(self):
        return [c for c in self.children if isinstance(c, Node)]

    def kids(self, *tags):
        return [c for c in self.elements() if c.tag in tags]

    def first(self, *tags):
        for c in self.elements():
            if c.tag in tags:
                return c
        return None


class DOMBuilder(HTMLParser):
    """Minimal tolerant HTML tree builder. Stdlib only, no dependencies."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {})
        self.stack = [self.root]

    def _open(self, tag, attrs):
        if tag in AUTO_CLOSE and self.stack[-1].tag == tag:
            self.stack.pop()
        node = Node(tag, {k: (v or "") for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)
        return node

    def handle_starttag(self, tag, attrs):
        self._open(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        self._open(tag, attrs)
        if tag not in VOID_TAGS:
            self.stack.pop()

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data.strip():
            self.stack[-1].children.append(data)


def is_noise(node):
    if node.tag in NOISE_TAGS:
        return True
    return bool(NOISE_CLASS.search(node.attrs.get("class", "")))


def collapse(text):
    return re.sub(r"\s+", " ", text).strip()


def text_of(node, skip=frozenset()):
    """Text of a subtree, minus noise subtrees and any node in `skip`."""
    out = []

    def walk(n):
        for child in n.children:
            if isinstance(child, str):
                out.append(child)
            elif child in skip:
                continue
            elif not is_noise(child):
                walk(child)

    walk(node)
    return collapse("".join(out))


# ------------------------------------------------------------------ normalisation

def normalize(text):
    """Canonical form for storage and display.

    AMD writes "Radeon(TM) RX 7000" and "AMD Software: Adrenalin Edition"; the
    tracker stores "Radeon RX 7000" and "AMD Software". Without this step no
    imported line can ever match a stored record.
    """
    s = text
    for ch in ("\u2122", "\u00ae", "\u00a9", "\u200b", "\ufeff"):
        s = s.replace(ch, "")
    s = s.replace("\u00a0", " ")
    s = re.sub(r"[\u2018\u2019\u02bc\u2032]", "'", s)
    s = re.sub(r"[\u201c\u201d\u2033]", '"', s)
    s = re.sub(r"[\u2010\u2011\u2012\u2013\u2014\u2212]", "-", s)
    s = s.replace("\u2026", "...")
    s = re.sub(r"\bAMD Software:\s*Adrenalin Edition\b", "AMD Software", s, flags=re.I)
    s = re.sub(r"\bAMD Software:\s*Adrenalin\b", "AMD Software", s, flags=re.I)
    return collapse(s)


def match_key(text):
    """Aggressive key used only for proposing matches. Never shown to users."""
    s = normalize(text).lower()
    s = s.replace("'", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return collapse(s)


# --------------------------------------------------------------------- extraction

def walk_blocks(node, out):
    """Collect headings and top-level lists in document order."""
    for child in node.elements():
        if is_noise(child):
            continue
        if child.tag in HEADING_TAGS:
            out.append(("heading", child))
        elif child.tag in ("ul", "ol"):
            out.append(("list", child))
        else:
            walk_blocks(child, out)


def parse_list(ul):
    """Return [{"label": str|None, "items": [str]}].

    A list item that contains a nested list is a group label ("Fixed Issues"),
    not an item. A flat list is a single unlabelled group.
    """
    groups = []
    any_label = False
    for li in ul.kids("li"):
        nested = li.first("ul", "ol")
        if nested is not None:
            label = text_of(li, skip={nested})
            items = [text_of(x) for x in nested.kids("li")]
            items = [i for i in items if i]
            if items:
                groups.append({"label": label or None, "items": items})
                any_label = any_label or bool(label)
                continue
        item = text_of(li)
        if item:
            groups.append({"label": None, "items": [item]})

    if not any_label:
        flat = [i for g in groups for i in g["items"]]
        return [{"label": None, "items": flat}] if flat else []

    merged, pending = [], []
    for g in groups:
        if g["label"] is None:
            pending.extend(g["items"])
        else:
            if pending:
                merged.append({"label": None, "items": pending})
                pending = []
            merged.append(g)
    if pending:
        merged.append({"label": None, "items": pending})
    return merged


def classify(section, label):
    hay = f"{section or ''} {label or ''}".lower()
    if "known issue" in hay:
        return "known"
    if "fixed issue" in hay:
        return "fixed"
    return "other"


def parse_sections(root):
    blocks = []
    walk_blocks(root, blocks)

    sections, current = [], None
    for kind, node in blocks:
        if kind == "heading":
            title = text_of(node)
            current = {"section": title, "level": int(node.tag[1]), "groups": []}
            sections.append(current)
        else:
            if current is None:
                current = {"section": "", "level": 0, "groups": []}
                sections.append(current)
            current["groups"].extend(parse_list(node))
    return [s for s in sections if s["groups"]]


def build_sections(sections):
    """Keep only groups worth a reviewer's attention.

    Unlabelled 'other' groups are compatibility lists and package contents: real
    content, but never issues, and they repeat once per product family.
    """
    out = []
    for sec in sections:
        groups = []
        for group in sec["groups"]:
            kind = classify(sec["section"], group["label"])
            if kind == "other" and not group["label"]:
                continue
            groups.append({
                "label": group["label"],
                "kind": kind,
                "items": [normalize(i) for i in group["items"]],
            })
        if groups:
            out.append({"section": sec["section"], "groups": groups})
    return out


def extract(html, version, date, url):
    builder = DOMBuilder()
    builder.feed(html)

    sections = parse_sections(builder.root)
    candidates, seen = [], set()
    unrecognized = []

    for sec in sections:
        for group in sec["groups"]:
            kind = classify(sec["section"], group["label"])
            # Only known/fixed groups are issues. "New Game Support" and the
            # compatibility lists are context, and stay in `sections` only.
            if kind == "other":
                if group["label"] and group["label"].lower() not in (
                        l.lower() for l in unrecognized):
                    unrecognized.append(f"{sec['section']} / {group['label']}")
                continue
            for raw in group["items"]:
                text = normalize(raw)
                if len(text) < 25:
                    continue
                key = match_key(text)
                if key in seen:
                    continue
                seen.add(key)
                candidates.append({
                    "text": text,
                    "match_key": key,
                    "kind": kind,
                    "section": sec["section"],
                    "group": group["label"],
                    "first": version,
                    "last_seen": version,
                    "status": "fixed" if kind == "fixed" else "pending",
                    "fixed_in": version if kind == "fixed" else None,
                    "sources": [version],
                })

    known = [c for c in candidates if c["kind"] == "known"]
    fixed = [c for c in candidates if c["kind"] == "fixed"]

    # B3: AMD carries an issue forward into Known Issues after fixing it. Flag it
    # rather than letting a reviewer create a phantom "still pending" record.
    known_keys = {c["match_key"] for c in known}
    for c in fixed:
        c["also_listed_as_known"] = c["match_key"] in known_keys

    return {
        "version": version,
        "date": date,
        "url": url,
        "sections": build_sections(sections),
        "candidates": candidates,
        "known_issue_candidates": [c["text"] for c in known],
        "fixed_issue_candidates": [c["text"] for c in fixed],
        "carried_forward": [c["text"] for c in fixed if c.get("also_listed_as_known")],
        # If AMD renames a section, these labels are how a reviewer finds out
        # instead of silently importing zero issues.
        "unrecognized_labels": unrecognized,
        "review_required": True,
    }


# ------------------------------------------------------------------------ hints

def load_tracker(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return data.get("bugs", [])


def add_match_hints(result, tracker, threshold):
    pool = [(b.get("id"), match_key(b.get("text", ""))) for b in tracker]
    pool = [(i, k) for i, k in pool if k]
    for c in result["candidates"]:
        scored = []
        for bug_id, key in pool:
            ratio = difflib.SequenceMatcher(None, c["match_key"], key).ratio()
            if ratio >= threshold:
                scored.append({"id": bug_id, "similarity": round(ratio, 3)})
        scored.sort(key=lambda x: -x["similarity"])
        c["match_hints"] = scored[:5]
        c["known_to_tracker"] = bool(scored and scored[0]["similarity"] >= 0.95)
    result["match_threshold"] = threshold


# --------------------------------------------------------------------------- io

def cache_path(cache_dir, url):
    return os.path.join(cache_dir, re.sub(r"[^A-Za-z0-9._-]+", "_", url) + ".html")


def fetch(url, cache_dir, offline, attempts=4, user_agent=USER_AGENT, delay=0.0):
    """Fetch with retries. AMD's CDN times out under load; a single attempt is
    not good enough for a backfill over dozens of pages."""
    cached = cache_path(cache_dir, url) if cache_dir else None
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        if os.path.exists(cached):
            with open(cached, encoding="utf-8", errors="replace") as fh:
                return fh.read(), cached
    if offline:
        sys.exit(f"offline and no cached copy at {cached}")

    last = None
    for attempt in range(1, attempts + 1):
        try:
            if delay:
                time.sleep(delay)
            req = Request(url, headers={
                "User-Agent": user_agent,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urlopen(req, timeout=45) as resp:
                raw = resp.read().decode("utf-8", "replace")
            if cached:
                with open(cached, "w", encoding="utf-8") as fh:
                    fh.write(raw)
            return raw, None
        except Exception as exc:  # noqa: BLE001 - network errors are all retryable
            last = exc
            if attempt < attempts:
                time.sleep(2 ** attempt)
    sys.exit(f"failed after {attempts} attempts: {url}\n  {last}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("url", nargs="?", help="Exact AMD release-notes URL")
    ap.add_argument("--version", required=True)
    ap.add_argument("--date", default="")
    ap.add_argument("--html", help="Parse a local HTML file instead of fetching")
    ap.add_argument("--cache", default="cache", help="Directory for raw HTML ('' disables)")
    ap.add_argument("--offline", action="store_true", help="Never hit the network")
    ap.add_argument("--delay", type=float, default=1.5,
                    help="Seconds between requests, for backfills (default 1.5)")
    ap.add_argument("--user-agent", default=USER_AGENT)
    ap.add_argument("--tracker", default="data/tracker.json")
    ap.add_argument("--threshold", type=float, default=0.72)
    ap.add_argument("--out", help="Write the draft JSON here")
    args = ap.parse_args()

    if args.html:
        with open(args.html, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    elif args.url:
        raw, _ = fetch(args.url, args.cache or None, args.offline,
                       user_agent=args.user_agent, delay=args.delay)
    else:
        ap.error("give a URL or --html")

    result = extract(raw, args.version, args.date, args.url or "")
    result["source_sha256"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    result["extracted_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    add_match_hints(result, load_tracker(args.tracker), args.threshold)

    payload = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
        print(f"{len(result['known_issue_candidates'])} known, "
              f"{len(result['fixed_issue_candidates'])} fixed, "
              f"{len(result['carried_forward'])} carried forward -> {args.out}")
    else:
        print(payload)


if __name__ == "__main__":
    main()
