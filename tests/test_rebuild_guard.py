#!/usr/bin/env python3
"""Tests for the auto-publish guard.

Publishing to main unattended only works if the guard is strict enough to catch a bad
rebuild *and* loose enough that ordinary churn passes. A guard that never blocks certifies
everything; a guard that blocks ordinary churn gets ignored. These tests pin both sides.
"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from check_rebuild import check  # noqa: E402


def tracker(drivers, bugs, contiguous=True):
    return {
        "drivers": [{"version": v} for v in drivers],
        "bugs": bugs,
        "meta": {"contiguous": contiguous},
    }


def bug(text, status):
    return {"text": text, "status": status}


BEFORE = tracker(["26.1.1", "26.2.1"], [bug("A", "fixed"), bug("B", "pending")])
NO_MERGES = {"fuzzy_merges": []}


class OrdinaryChurnTest(unittest.TestCase):
    """The guard must not fire on the things a normal rebuild does."""

    def test_a_release_being_added_passes(self):
        after = tracker(["26.1.1", "26.2.1", "26.3.1"],
                        [bug("A", "fixed"), bug("B", "pending"), bug("C", "pending")])
        self.assertEqual(check(BEFORE, after, NO_MERGES), [])

    def test_a_pending_issue_becoming_fixed_passes(self):
        after = tracker(["26.1.1", "26.2.1"], [bug("A", "fixed"), bug("B", "fixed")])
        self.assertEqual(check(BEFORE, after, NO_MERGES), [])

    def test_a_shrink_explained_by_a_recorded_merge_passes(self):
        after = tracker(["26.1.1", "26.2.1"], [bug("A", "fixed")])
        self.assertEqual(check(BEFORE, after, {"fuzzy_merges": [{"incoming": "B"}]}), [])

    def test_a_no_op_rebuild_of_the_shipped_tracker_passes(self):
        # Positive control on real data. If this ever fails, the guard would block every
        # publish and the automation would be worse than useless.
        with open(os.path.join(ROOT, "data", "tracker.json"), encoding="utf-8") as fh:
            live = json.load(fh)
        self.assertEqual(check(live, live, NO_MERGES), [])


class RegressionTest(unittest.TestCase):
    """Each check has to be able to fire, or it is not a check."""

    def test_a_lost_release_blocks(self):
        after = tracker(["26.2.1"], [bug("A", "fixed"), bug("B", "pending")])
        problems = check(BEFORE, after, NO_MERGES)
        self.assertTrue(any("disappeared" in p for p in problems), problems)

    def test_a_fix_reverting_to_pending_blocks(self):
        after = tracker(["26.1.1", "26.2.1"], [bug("A", "pending"), bug("B", "pending")])
        problems = check(BEFORE, after, NO_MERGES)
        self.assertTrue(any("back to pending" in p for p in problems), problems)

    def test_coverage_going_gappy_blocks(self):
        after = tracker(["26.1.1", "26.2.1"], [bug("A", "fixed"), bug("B", "pending")],
                        contiguous=False)
        problems = check(BEFORE, after, NO_MERGES)
        self.assertTrue(any("contiguous" in p for p in problems), problems)

    def test_an_unexplained_shrink_blocks(self):
        after = tracker(["26.1.1", "26.2.1"], [bug("A", "fixed")])
        problems = check(BEFORE, after, NO_MERGES)
        self.assertTrue(any("merge" in p for p in problems), problems)

    def test_an_empty_rebuild_blocks_rather_than_looking_quiet(self):
        # The dangerous shape: a rebuild that produced almost nothing must not read as
        # "nothing changed, carry on".
        self.assertNotEqual(check(BEFORE, tracker([], []), NO_MERGES), [])


if __name__ == "__main__":
    unittest.main()
