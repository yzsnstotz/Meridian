from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "dispatch.py"
spec = importlib.util.spec_from_file_location("dispatch_script", SCRIPT_PATH)
assert spec and spec.loader
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)


class DispatchTemplateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.taskspec_dir = self.root / "taskspec"
        self.taskspec_dir.mkdir()
        (self.taskspec_dir / "dispatch_plan.md").write_text(
            "\n".join(
                [
                    "| Status | Batch | Worker |",
                    "| --- | --- | --- |",
                    "| pending | 1 | W-01 |",
                ]
            ),
            encoding="utf-8",
        )
        (self.taskspec_dir / "dispatch_command.md").write_text("dispatch workers", encoding="utf-8")
        self.store_path = self.root / "templates.json"
        self.previous_store = os.environ.get("MERIDIAN_DISPATCH_TEMPLATE_STORE")
        os.environ["MERIDIAN_DISPATCH_TEMPLATE_STORE"] = str(self.store_path)

    def tearDown(self) -> None:
        if self.previous_store is None:
            os.environ.pop("MERIDIAN_DISPATCH_TEMPLATE_STORE", None)
        else:
            os.environ["MERIDIAN_DISPATCH_TEMPLATE_STORE"] = self.previous_store
        self.tempdir.cleanup()

    def run_dispatch(self, argv: list[str]) -> tuple[int, dict[str, object], str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = dispatch.main(argv)
        stream = stdout.getvalue() if code == 0 else stderr.getvalue()
        payload = json.loads(stream)
        return code, payload, stream

    def write_store(self, templates: dict[str, dict[str, object]]) -> None:
        self.store_path.write_text(json.dumps({"version": 1, "templates": templates}), encoding="utf-8")

    def test_dynamic_template_flag_applies_stored_dispatcher_settings(self) -> None:
        self.write_store(
            {
                "ops": {
                    "agent_type": "claude",
                    "model_id": "claude-opus-4",
                    "reply_channel": ["telegram:123"],
                    "validator_enabled": False,
                    "pm_model_id": "pm-model",
                    "model_map": "W=openai:gpt-5",
                    "parallel_dispatch_enabled": True,
                    "parallel_dispatch_max_concurrency": 3,
                }
            }
        )

        code, result, _ = self.run_dispatch([str(self.taskspec_dir), "--ops", "--dry-run"])

        self.assertEqual(code, 0)
        payload = result["payload"]
        self.assertEqual(payload["agent_type"], "claude")
        self.assertEqual(payload["model_id"], "claude-opus-4")
        self.assertEqual(payload["user_reply_channels"], [{"channel": "telegram", "chat_id": "telegram:123"}])
        self.assertEqual(payload["validator"], {"enabled": False})
        self.assertEqual(payload["pm_resolver"]["model_id"], "pm-model")
        self.assertEqual(payload["config"], {"model_map": {"W": {"provider": "openai", "model_id": "gpt-5"}}})
        self.assertEqual(payload["parallel_dispatch"], {"enabled": True, "max_concurrency": 3})
        self.assertEqual(result["templates_applied"], ["ops"])

    def test_explicit_cli_flags_override_template_values(self) -> None:
        self.write_store(
            {
                "dev": {
                    "agent_type": "claude",
                    "validator_base_branch": "develop",
                    "pm_enabled": False,
                }
            }
        )

        code, result, _ = self.run_dispatch(
            [
                str(self.taskspec_dir),
                "--dev",
                "--agent-type",
                "codex",
                "--validator-base-branch",
                "feature/template-cli",
                "--pm-enabled",
                "--dry-run",
            ]
        )

        self.assertEqual(code, 0)
        payload = result["payload"]
        self.assertEqual(payload["agent_type"], "codex")
        self.assertEqual(payload["validator"]["base_branch"], "feature/template-cli")
        self.assertTrue(payload["pm_resolver"]["enabled"])

    def test_save_template_records_only_explicit_dispatcher_flags_without_launching(self) -> None:
        code, result, _ = self.run_dispatch(
            [
                "--save-template",
                "nightly",
                "--agent-type",
                "gemini",
                "--no-pm",
                "--reply-channel",
                "web:ops",
                "--model-map",
                "A=openai:gpt-5",
                "--parallel-dispatch-enabled",
                "--parallel-dispatch-max-concurrency",
                "3",
            ]
        )

        self.assertEqual(code, 0)
        self.assertEqual(result["action"], "save_template")
        self.assertEqual(result["template"], "nightly")
        stored = json.loads(self.store_path.read_text(encoding="utf-8"))
        self.assertEqual(
            stored["templates"]["nightly"],
            {
                "agent_type": "gemini",
                "pm_enabled": False,
                "reply_channel": ["web:ops"],
                "model_map": "A=openai:gpt-5",
                "parallel_dispatch_enabled": True,
                "parallel_dispatch_max_concurrency": 3,
            },
        )

    def test_template_management_lists_shows_and_deletes_templates(self) -> None:
        self.write_store({"ops": {"agent_type": "codex"}})

        code, listed, _ = self.run_dispatch(["--list-templates"])
        self.assertEqual(code, 0)
        self.assertEqual(listed["templates"], ["ops"])

        code, shown, _ = self.run_dispatch(["--show-template", "ops"])
        self.assertEqual(code, 0)
        self.assertEqual(shown["settings"], {"agent_type": "codex"})

        code, deleted, _ = self.run_dispatch(["--delete-template", "ops"])
        self.assertEqual(code, 0)
        self.assertEqual(deleted["action"], "delete_template")
        self.assertEqual(json.loads(self.store_path.read_text(encoding="utf-8"))["templates"], {})

    def test_unknown_long_flag_errors_when_no_matching_template_exists(self) -> None:
        code, result, _ = self.run_dispatch([str(self.taskspec_dir), "--typo", "--dry-run"])

        self.assertNotEqual(code, 0)
        self.assertIn("Unknown option or dispatch template: --typo", result["error"])


if __name__ == "__main__":
    unittest.main()
