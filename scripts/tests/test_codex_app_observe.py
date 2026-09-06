import importlib.util
import json
from pathlib import Path
import sqlite3
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
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?, ?)", ("native-thread", str(self.rollout)))

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


if __name__ == "__main__":
    unittest.main()
