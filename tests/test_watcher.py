#!/usr/bin/env python3
"""Tests for the scheduled release watcher.

The watcher's candidate window is the part that can fail silently. If it ever stops
reaching the present, the watcher keeps reporting "up to date" and the tracker quietly
freezes -- and a green scheduled run is exactly what you would expect to see. These tests
pin the property that matters: however far behind the tracker is, the window still covers
the current month.
"""
import os
import sys
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from watch_releases import window, version_key  # noqa: E402


def months_after(year, month, count):
    """`count` months after year-month, as a datetime on the 15th."""
    month += count
    year += (month - 1) // 12
    month = (month - 1) % 12 + 1
    return datetime(year, month, 15, tzinfo=timezone.utc)


class WindowTest(unittest.TestCase):
    def test_window_reaches_the_current_month_however_stale_the_tracker(self):
        # The regression: anchoring the window to start_version + lookahead meant a tracker
        # more than two months behind never probed the present again, so the watcher
        # reported "up to date" forever instead of catching up.
        for months_behind in (0, 1, 2, 3, 6, 14, 30):
            now = months_after(2026, 9, months_behind)
            candidates = window("26.9.2", now, 2, 5)
            self.assertTrue(candidates, f"empty window with now={now:%Y-%m}")
            newest = max(candidates, key=version_key)
            self.assertGreaterEqual(
                version_key(newest), (now.year % 100, now.month, 1),
                f"window ends at {newest} but the present is {now:%Y-%m}: the watcher would "
                f"report 'up to date' and never catch up")

    def test_window_never_offers_a_release_older_than_the_newest_tracked_one(self):
        candidates = window("26.9.2", months_after(2027, 3, 0), 2, 5)
        self.assertGreaterEqual(min(version_key(v) for v in candidates), version_key("26.9.2"))

    def test_window_does_not_probe_the_far_future(self):
        # It has to reach the present, not the year 3000.
        candidates = window("26.9.2", datetime(2026, 10, 9, tzinfo=timezone.utc), 2, 5)
        self.assertLessEqual(version_key(max(candidates, key=version_key)), (26, 11, 9))

    def test_a_fresh_tracker_still_looks_a_couple_of_months_ahead(self):
        # The normal case must not collapse to "current month only": AMD may already have
        # published next month's note before the month turns.
        candidates = window("26.9.2", datetime(2026, 10, 9, tzinfo=timezone.utc), 2, 5)
        self.assertGreaterEqual(version_key(max(candidates, key=version_key)), (26, 11, 1))

    def test_a_stale_window_covers_every_month_it_spans(self):
        # Catching up has to be complete, not just reach the current month: a release that
        # shipped during the gap must be in the window too.
        candidates = window("26.9.2", months_after(2027, 1, 0), 2, 5)
        seen = {tuple(int(p) for p in v.split("."))[:2] for v in candidates}
        for year, month in [(26, 10), (26, 11), (26, 12), (27, 1)]:
            self.assertIn((year, month), seen, f"{year}.{month} is missing from the window")


if __name__ == "__main__":
    unittest.main()
