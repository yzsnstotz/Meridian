import importlib.util
import datetime as dt
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("codex_app_observe", Path(__file__).parents[1] / "codex-app-observe.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ObserveContinuationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rollout = self.root / "rollout.jsonl"
        self.db = self.root / "state.sqlite"
        self.request = {"id": "request-one", "threadId": "native-thread", "turnId": "repair-turn"}
        self.created_at = int(dt.datetime(2026, 9, 7, tzinfo=dt.timezone.utc).timestamp())
        self.unbound_request = {"id": "request-one", "createdAt": "2026-09-07T00:00:00Z"}
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, source TEXT)")
            db.execute("INSERT INTO threads VALUES (?, ?, ?, ?)",
                       ("native-thread", str(self.rollout), self.created_at, "vscode"))

    def rows(self, name="send_message_to_thread", namespace="codex_app", turn="repair-turn"):
        marker = "[Meridian App handoff request: request-one]"
        return [
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn}},
            {"type": "response_item", "payload": {"type": "function_call_output", "namespace": namespace,
             "name": name, "output": "<codex_delegation><input>" + marker + "</input></codex_delegation>"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "phase": "commentary",
             "content": [{"type": "output_text", "text": "Fixing the independently reproduced issue."}]}},
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn,
             "last_agent_message": "Actual final\n<<<MERIDIAN-STATUS>>>\noutcome: complete\n<<<END>>>"}},
        ]

    def write(self, rows):
        self.rollout.write_text("\n".join(json.dumps(row) for row in rows) + "\n")

    def set_source(self, source):
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE threads SET source=? WHERE id='native-thread'", (source,))

    def add_candidate(self, thread_id, rows, source="unknown", created_at=None):
        rollout = self.root / (thread_id + ".jsonl")
        rollout.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        with sqlite3.connect(self.db) as db:
            db.execute("INSERT INTO threads VALUES (?, ?, ?, ?)",
                       (thread_id, str(rollout), self.created_at if created_at is None else created_at, source))

    def test_same_thread_continuation_recovers_exact_terminal_and_progress(self):
        self.write(self.rows())
        before = self.db.read_bytes(), self.rollout.read_bytes()
        result = MODULE.observe(self.request, self.db)
        self.assertEqual(result["threadId"], "native-thread")
        self.assertEqual(result["turnId"], "repair-turn")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["text"], self.rows()[-1]["payload"]["last_agent_message"])
        self.assertEqual(result["progress"], "Fixing the independently reproduced issue.")
        self.assertEqual(before, (self.db.read_bytes(), self.rollout.read_bytes()))

    def test_new_thread_delegation_still_recovers(self):
        self.write(self.rows(name="create_thread"))
        self.assertEqual(MODULE.observe(self.request, self.db)["status"], "completed")

    def test_native_error_wins_null_or_present_final_for_exact_turn(self):
        for final in [None, "A misleading success final"]:
            with self.subTest(final=final):
                rows = self.rows()
                rows[-1]["payload"].update(last_agent_message=final,
                    error={"message": "Provider denied this request", "codex_error_info": "some_code"})
                self.write(rows)
                before = self.db.read_bytes(), self.rollout.read_bytes()
                result = MODULE.observe(self.request, self.db)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["text"], "Provider denied this request")
                self.assertEqual(before, (self.db.read_bytes(), self.rollout.read_bytes()))

    def test_malformed_native_error_never_reports_success(self):
        for error in [{}, {"message": None}, {"message": 123}, {"message": "  "}, "denied", False, []]:
            with self.subTest(error=error):
                rows = self.rows()
                rows[-1]["payload"]["error"] = error
                self.write(rows)
                result = MODULE.observe(self.request, self.db)
                self.assertEqual(result["status"], "failed")
                self.assertIsNone(result["text"])

    def test_null_final_without_error_stays_without_terminal_text(self):
        rows = self.rows()
        rows[-1]["payload"]["last_agent_message"] = None
        self.write(rows)
        self.assertIsNone(MODULE.observe(self.request, self.db)["text"])

    def test_cross_turn_error_cannot_terminate_bound_turn(self):
        rows = self.rows()
        rows[-1]["payload"].update(turn_id="another-turn", last_agent_message=None,
            error={"message": "Unrelated failure"})
        self.write(rows)
        result = MODULE.observe(self.request, self.db)
        self.assertEqual(result["status"], "running")
        self.assertNotIn("text", result)

    def test_unrelated_function_outputs_cannot_supply_the_input_marker(self):
        for name, namespace in [("exec", "codex_app"), ("send_message_to_thread", "untrusted")]:
            with self.subTest(name=name, namespace=namespace):
                self.write(self.rows(name=name, namespace=namespace))
                with self.assertRaisesRegex(RuntimeError, "found 0"):
                    MODULE.observe(self.request, self.db)

    def test_a_different_bound_turn_is_rejected(self):
        self.write(self.rows(turn="other-turn"))
        with self.assertRaisesRegex(RuntimeError, "conflicts with recorded turn"):
            MODULE.observe(self.request, self.db)

    def test_duplicate_marker_turns_are_rejected(self):
        self.write(self.rows() + self.rows(turn="other-turn"))
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            MODULE.observe(self.request, self.db)

    def test_report_or_assistant_marker_does_not_match_a_submission(self):
        rows = self.rows()
        rows[1]["payload"] = {"type": "message", "role": "assistant", "phase": "commentary",
            "content": [{"type": "output_text", "text": "[Meridian App handoff request: request-one]"}]}
        self.write(rows)
        with self.assertRaisesRegex(RuntimeError, "found 0"):
            MODULE.observe(self.request, self.db)

    def test_unbound_unknown_source_recovers_native_delegation_only(self):
        self.set_source("unknown")
        for name in ["create_thread", "send_message_to_thread"]:
            for completed in [False, True]:
                with self.subTest(name=name, completed=completed):
                    rows = self.rows(name=name)
                    self.write(rows if completed else rows[:-1])
                    before = self.db.read_bytes(), self.rollout.read_bytes()
                    result = MODULE.observe(self.unbound_request, self.db)
                    self.assertEqual(result["threadId"], "native-thread")
                    self.assertEqual(result["turnId"], "repair-turn")
                    self.assertEqual(result["status"], "completed" if completed else "running")
                    self.assertEqual(result["progress"], "Fixing the independently reproduced issue.")
                    if completed:
                        self.assertEqual(result["text"], rows[-1]["payload"]["last_agent_message"])
                    self.assertEqual(before, (self.db.read_bytes(), self.rollout.read_bytes()))

    def test_unknown_source_user_or_assistant_cannot_spoof_native_delegation(self):
        self.set_source("unknown")
        for role in ["user", "assistant"]:
            with self.subTest(role=role):
                rows = self.rows()
                # Even a complete native-looking record quoted in a message
                # must not count as a real delegation response item.
                rows[1]["payload"] = {"type": "message", "role": role,
                    "content": [{"type": "input_text", "text": json.dumps(rows[1]["payload"])}]}
                self.write(rows)
                with self.assertRaisesRegex(RuntimeError, "found 0"):
                    MODULE.observe(self.unbound_request, self.db)

    def test_unknown_source_requires_exact_native_tool_namespace_and_name(self):
        self.set_source("unknown")
        for name, namespace in [("exec", "codex_app"), ("create_thread", "untrusted"),
                                ("send_message_to_thread", "untrusted")]:
            with self.subTest(name=name, namespace=namespace):
                self.write(self.rows(name=name, namespace=namespace))
                with self.assertRaisesRegex(RuntimeError, "found 0"):
                    MODULE.observe(self.unbound_request, self.db)

    def test_unknown_source_delegation_must_mark_this_request_in_the_same_turn(self):
        self.set_source("unknown")
        rows = self.rows(turn="other-turn")
        rows[1]["payload"]["output"] = "[Meridian App handoff request: request-other]"
        quoted_turn = self.rows()
        quoted_turn[1]["payload"] = {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "[Meridian App handoff request: request-one]"}]}
        self.write(rows + quoted_turn)
        with self.assertRaisesRegex(RuntimeError, "found 0"):
            MODULE.observe(self.unbound_request, self.db)

    def test_unknown_source_rejects_conflicting_recorded_turn(self):
        self.set_source("unknown")
        self.write(self.rows(turn="other-turn"))
        with self.assertRaisesRegex(RuntimeError, "conflicts with recorded turn"):
            MODULE.observe({**self.unbound_request, "turnId": "repair-turn"}, self.db)

    def test_unknown_source_delegation_after_terminal_cannot_claim_the_old_turn(self):
        self.set_source("unknown")
        for terminal in ["task_complete", "turn_aborted"]:
            with self.subTest(terminal=terminal):
                rows = self.rows(turn="old-turn")
                rows[1]["payload"]["output"] = "[Meridian App handoff request: old-request]"
                rows[-1]["payload"]["type"] = terminal
                self.write(rows + [self.rows()[1]])
                with self.assertRaisesRegex(RuntimeError, "found 0"):
                    MODULE.observe(self.unbound_request, self.db)

    def test_unknown_source_ignores_between_turn_delegation_before_actual_next_turn(self):
        self.set_source("unknown")
        rows = self.rows(turn="old-turn")
        rows[1]["payload"]["output"] = "[Meridian App handoff request: old-request]"
        self.write(rows + [self.rows()[1]] + self.rows())
        result = MODULE.observe(self.unbound_request, self.db)
        self.assertEqual(result["turnId"], "repair-turn")
        self.assertEqual(result["text"], self.rows()[-1]["payload"]["last_agent_message"])

    def test_unbound_unknown_source_keeps_duplicate_turn_guard(self):
        self.set_source("unknown")
        self.write(self.rows() + self.rows(turn="other-turn"))
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            MODULE.observe(self.unbound_request, self.db)

    def test_unbound_discovery_rejects_ambiguity_across_sources(self):
        self.write(self.rows(name="create_thread"))
        self.add_candidate("unknown-thread", self.rows(name="create_thread", turn="another-turn"))
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            MODULE.observe(self.unbound_request, self.db)

    def test_unknown_candidate_limit_is_shared_with_vscode(self):
        self.write(self.rows())
        for index in range(99):
            self.add_candidate("unrelated-" + str(index), [], source="unknown" if index % 2 else "vscode")
        self.assertEqual(MODULE.observe(self.unbound_request, self.db)["threadId"], "native-thread")
        self.add_candidate("one-too-many", [])
        with self.assertRaisesRegex(RuntimeError, "Recovery candidates exceed bound"):
            MODULE.observe(self.unbound_request, self.db)

    def test_unbound_discovery_preserves_source_and_creation_window_filters(self):
        self.write(self.rows())
        self.add_candidate("old-unknown", self.rows(), created_at=self.created_at - 6)
        self.add_candidate("cli-thread", self.rows(), source="exec")
        self.assertEqual(MODULE.observe(self.unbound_request, self.db)["threadId"], "native-thread")

    def test_vscode_user_input_remains_supported(self):
        rows = self.rows()
        rows[1]["payload"] = {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "[Meridian App handoff request: request-one]"}]}
        self.write(rows)
        self.assertEqual(MODULE.observe(self.unbound_request, self.db)["turnId"], "repair-turn")

    def test_unknown_source_cli_preserves_private_output_and_read_only_storage(self):
        self.set_source("unknown")
        self.write(self.rows(name="create_thread"))
        request_file = self.root / "request.json"
        request_file.write_text(json.dumps(self.unbound_request))
        output = self.root / "observation.json"
        before = self.db.read_bytes(), self.rollout.read_bytes()
        command = [sys.executable, "-B", str(Path(__file__).parents[1] / "codex-app-observe.py"),
                   "--request-file", str(request_file), "--state-db", str(self.db), "--output", str(output)]
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(output.read_text(), result.stdout)
        self.assertEqual(set(json.loads(result.stdout)), {"threadId", "turnId", "status", "progress", "text"})
        self.assertNotIn("codex_delegation", result.stdout)
        self.assertEqual(before, (self.db.read_bytes(), self.rollout.read_bytes()))


if __name__ == "__main__":
    unittest.main()
