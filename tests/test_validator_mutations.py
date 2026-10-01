"""Mutation tests for scripts/validate_tracker.py.

A validator that cannot fail is worse than no validator: it certifies bad data.
Every invariant the validator claims to check gets a mutated copy of the shipped
database, and the validator must reject it with the *expected* message.

If any mutation is accepted, the validator is wrong -- fix the validator, not
this test.
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VALIDATOR = os.path.join(ROOT, "scripts", "validate_tracker.py")
DATA = os.path.join(ROOT, "data", "tracker.json")


def run_validator(doc):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tracker.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False)
        proc = subprocess.run(
            [sys.executable, VALIDATOR, path],
            capture_output=True, text=True,
        )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def mutate(fn):
    """Apply fn to a deep copy of the shipped database."""
    with open(DATA, encoding="utf-8") as fh:
        doc = json.load(fh)
    out = copy.deepcopy(doc)
    fn(out)
    return out


class ValidatorMutation(unittest.TestCase):
    """Each case must exit non-zero and name the invariant that caught it."""

    def assert_rejected(self, doc, expected):
        code, output = run_validator(doc)
        self.assertNotEqual(code, 0, f"validator accepted bad data.\n{output}")
        self.assertIn(expected, output, f"wrong check fired.\n{output}")

    # ------------------------------------------------------------- control
    def test_shipped_data_is_accepted(self):
        code, output = run_validator(mutate(lambda d: None))
        self.assertEqual(code, 0, output)

    # -------------------------------------------------------------- drivers
    def test_duplicate_driver_version(self):
        self.assert_rejected(
            mutate(lambda d: d["drivers"][1].__setitem__("version", d["drivers"][0]["version"])),
            "duplicate version")

    def test_driver_dates_out_of_order(self):
        self.assert_rejected(
            mutate(lambda d: d["drivers"][0].__setitem__("date", "2020-01-01")),
            "is listed before newer")

    def test_malformed_driver_date(self):
        self.assert_rejected(
            mutate(lambda d: d["drivers"][0].__setitem__("date", "29-09-2026")),
            "is not YYYY-MM-DD")

    def test_unknown_channel(self):
        self.assert_rejected(
            mutate(lambda d: d["drivers"][0].__setitem__("channel", "Beta")),
            "unknown channel")

    def test_non_https_url(self):
        self.assert_rejected(
            mutate(lambda d: d["drivers"][0].__setitem__("url", "http://example.com/rn.html")),
            "url must be https")

    def test_malformed_version(self):
        self.assert_rejected(
            mutate(lambda d: d["drivers"][0].__setitem__("version", "26.9")),
            "is not N.N.N")

    # ----------------------------------------------------------------- bugs
    def test_duplicate_bug_id(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][1].__setitem__("id", d["bugs"][0]["id"])),
            "duplicate id")

    def test_malformed_bug_id(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__("id", "AMD-1")),
            "id must match AMD-NNNN")

    def test_invalid_status(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__("status", "wontfix")),
            "must be 'pending' or 'fixed'")

    def test_fixed_without_fixed_in(self):
        def fn(d):
            d["bugs"][0]["status"] = "fixed"
            d["bugs"][0]["fixed_in"] = None
        self.assert_rejected(mutate(fn), "status is fixed but fixed_in is empty")

    def test_pending_with_fixed_in(self):
        def fn(d):
            target = next(b for b in d["bugs"] if b["status"] == "pending")
            target["fixed_in"] = target["first"]
        self.assert_rejected(mutate(fn), "status is pending but fixed_in")

    def test_dangling_version_reference(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__("first", "99.9.9")),
            "is not a tracked driver version")

    def test_last_seen_older_than_first(self):
        def fn(d):
            d["bugs"][0]["last_seen"] = "24.8.1"
            d["bugs"][0]["sources"] = ["26.9.2", "24.8.1"]
        self.assert_rejected(mutate(fn), "is older than first")

    def test_fixed_in_older_than_first(self):
        def fn(d):
            d["bugs"][0]["fixed_in"] = "24.8.1"
            d["bugs"][0]["sources"] = ["26.9.2", "24.8.1"]
        self.assert_rejected(mutate(fn), "is older than first")

    def test_sources_missing_first(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__("sources", ["26.8.1"])),
            "sources is missing first")

    def test_sources_containing_duplicates(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__("sources", ["26.9.2", "26.9.2"])),
            "sources contains duplicates")

    def test_empty_sources(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__("sources", [])),
            "sources must be a non-empty list")

    # -------------------------------------------------- normalisation gates
    def test_unstripped_trademark(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__(
                "text", d["bugs"][0]["text"].replace("Radeon", "Radeon\u2122"))),
            "not normalized")

    def test_unfolded_channel_suffix(self):
        self.assert_rejected(
            mutate(lambda d: d["bugs"][0].__setitem__(
                "text", d["bugs"][0]["text"] + " Fixed in AMD Software: Adrenalin Edition.")),
            "not normalized")

    def test_duplicate_text_after_normalization(self):
        def fn(d):
            # Same issue, different punctuation and spacing: must collide.
            d["bugs"][1]["text"] = "  " + d["bugs"][0]["text"] + "  "
        self.assert_rejected(mutate(fn), "duplicates bugs[")

    # ----------------------------------------------------------------- meta
    def test_missing_meta_field(self):
        self.assert_rejected(
            mutate(lambda d: d["meta"].pop("method")),
            "missing method")

    def test_malformed_generated_date(self):
        self.assert_rejected(
            mutate(lambda d: d["meta"].__setitem__("generated", "2026-13-45")),
            "is not a real date")

    # ---------------------------------------------------------- structural
    def test_empty_bug_list(self):
        self.assert_rejected(
            mutate(lambda d: d.__setitem__("bugs", [])),
            "must be a non-empty list")

    def test_missing_root_section(self):
        self.assert_rejected(
            mutate(lambda d: d.pop("drivers")),
            "missing drivers")


class ValidatorSelfCheck(unittest.TestCase):
    """Prove the mutation harness itself can fail, so a green run means something."""

    def test_harness_reports_success_for_good_data(self):
        code, output = run_validator(mutate(lambda d: None))
        self.assertEqual(code, 0, output)
        self.assertIn("ok ", output)

    def test_harness_reports_failure_for_broken_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tracker.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            proc = subprocess.run([sys.executable, VALIDATOR, path],
                                  capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not valid JSON", proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
