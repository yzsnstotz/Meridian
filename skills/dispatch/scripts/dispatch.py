#!/usr/bin/env python3
"""Start a Meridian agent-dispatcher from TaskSpec artifacts."""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_SERVICE_URL = "http://127.0.0.1:7701"
DEFAULT_FALLBACK_REPLY_CHANNEL = {"channel": "web", "chat_id": "web:ops"}
COMMAND_FILE_CANDIDATES = ("agent_dispatch_command.md", "dispatch_command.md")
AGENT_TYPES = ("claude", "codex", "gemini", "cursor")
TEMPLATE_STORE_VERSION = 1
TEMPLATE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
TEMPLATE_MANAGEMENT_DESTS = {
    "delete_template",
    "list_templates",
    "save_template",
    "show_template",
}
NON_TEMPLATE_DESTS = {
    "command",
    "delete_template",
    "dry_run",
    "help",
    "list_templates",
    "plan",
    "save_template",
    "show_template",
    "target",
    "taskspec_dir",
    "template",
    "template_store",
}
EXCLUSIVE_TEMPLATE_GROUPS = (
    {"reply_channel", "reply_channels"},
    {"model_map", "model_map_file"},
)
BOOLEAN_TEMPLATE_DESTS = {
    "auto_approve",
    "parallel_dispatch_enabled",
    "pm_auto_approve",
    "pm_enabled",
    "validator_auto_approve",
    "validator_enabled",
}
INTEGER_TEMPLATE_DESTS = {"parallel_dispatch_max_concurrency", "validator_max_fix_cycles"}
FLOAT_TEMPLATE_DESTS = {"validator_pass_threshold"}
LIST_TEMPLATE_DESTS = {"reply_channel"}
TEMPLATE_CHOICES = {
    "agent_type": set(AGENT_TYPES),
    "kill_policy": {"always", "on_success", "never"},
    "mode": {"bridge"},
    "pm_agent_type": set(AGENT_TYPES),
    "pm_mode": {"bridge"},
    "validator_agent_type": set(AGENT_TYPES),
    "validator_mode": {"bridge", "stateless_call"},
    "validator_threshold_type": {"score", "binary"},
}


class DispatchError(Exception):
    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        management_result = handle_template_management(args)
        if management_result is not None:
            print(json.dumps(management_result, indent=2, sort_keys=True))
            return 0

        resolved = resolve_artifacts(args)
        rows = validate_dispatch_plan(resolved["plan_path"])
        service_url = normalize_service_url(args.service_url)
        reply_channels = resolve_reply_channels(args, service_url)
        payload = build_payload(args, resolved, reply_channels)

        result: dict[str, Any] = {
            "ok": True,
            "dry_run": bool(args.dry_run),
            "service_url": service_url,
            "resolved": {
                "taskspec_dir": str(resolved["taskspec_dir"]) if resolved["taskspec_dir"] else None,
                "dispatch_plan_path": str(resolved["plan_path"]),
                "command_file_path": str(resolved["command_path"]),
                "worker_count": len(rows),
            },
            "payload": payload,
        }
        if args.templates_applied:
            result["templates_applied"] = args.templates_applied

        if not args.dry_run:
            response = request_json(service_url, "/api/agent-dispatcher/start", method="POST", body=payload)
            result["response"] = response
            result["dispatcher_id"] = response.get("dispatcher_id")
            result["dispatcher_thread_id"] = response.get("dispatcher_thread_id")

        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except DispatchError as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2, sort_keys=True), file=sys.stderr)
        return error.exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve TaskSpec dispatch artifacts and start Meridian /api/agent-dispatcher/start.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        epilog="Stored dispatch templates can be applied with --template NAME or the shorthand --NAME.",
    )
    parser.add_argument(
        "target",
        nargs="?",
        help="TaskSpec directory, parent directory containing taskspec/, or direct dispatch_plan.md path.",
    )
    parser.add_argument("--taskspec-dir", help="Explicit TaskSpec directory.")
    parser.add_argument("--plan", help="Explicit dispatch_plan.md path.")
    parser.add_argument("--command", help="Explicit command file path.")
    parser.add_argument("--repo-root", help="Override dispatch_repo_root.")
    parser.add_argument("--docs-root", help="Override docs_root.")
    parser.add_argument(
        "--service-url",
        default=os.environ.get("MERIDIAN_ROLES_HTTP", DEFAULT_SERVICE_URL),
        help="Meridian-roles service URL.",
    )
    parser.add_argument(
        "--reply-channel",
        action="append",
        default=[],
        help="Repeatable reply channel. Accepts JSON or shorthand like web:ops / telegram:6137086342.",
    )
    parser.add_argument("--reply-channels", help="JSON array of reply channel objects.")
    parser.add_argument("--agent-type", choices=AGENT_TYPES, default="codex")
    parser.add_argument("--model-id", help="Dispatcher model id. Omit to use Hub/provider default.")
    parser.add_argument("--credential-id", help="Managed credential id forwarded to Hub.")
    parser.add_argument("--mode", choices=("bridge",), default="bridge")
    parser.add_argument("--kill-policy", choices=("always", "on_success", "never"), default="always")
    parser.set_defaults(auto_approve=True)
    parser.add_argument("--auto-approve", dest="auto_approve", action="store_true")
    parser.add_argument("--no-auto-approve", dest="auto_approve", action="store_false")

    parser.set_defaults(pm_enabled=True, pm_auto_approve=True)
    parser.add_argument("--pm-enabled", dest="pm_enabled", action="store_true")
    parser.add_argument("--no-pm", dest="pm_enabled", action="store_false")
    parser.add_argument("--pm-agent-type", choices=AGENT_TYPES, default="codex")
    parser.add_argument("--pm-model-id", help="PM resolver model id. Omit to use Hub/provider default.")
    parser.add_argument("--pm-mode", choices=("bridge",), default="bridge")
    parser.add_argument("--pm-auto-approve", dest="pm_auto_approve", action="store_true")
    parser.add_argument("--pm-no-auto-approve", dest="pm_auto_approve", action="store_false")

    parser.set_defaults(validator_enabled=True, validator_auto_approve=False)
    parser.add_argument("--validator-enabled", dest="validator_enabled", action="store_true")
    parser.add_argument("--no-validator", dest="validator_enabled", action="store_false")
    parser.add_argument("--validator-agent-type", choices=AGENT_TYPES, default="codex")
    parser.add_argument("--validator-model-id", help="Validator model id. Omit to use Hub/provider default.")
    parser.add_argument("--validator-mode", choices=("bridge", "stateless_call"), default="stateless_call")
    parser.add_argument("--validator-auto-approve", dest="validator_auto_approve", action="store_true")
    parser.add_argument("--validator-no-auto-approve", dest="validator_auto_approve", action="store_false")
    parser.add_argument("--validator-threshold-type", choices=("score", "binary"), default="binary")
    parser.add_argument("--validator-pass-threshold", type=float, default=0.7)
    parser.add_argument("--validator-max-fix-cycles", type=int, default=5)
    parser.add_argument("--validator-base-branch", default="main")

    parser.add_argument("--model-map", help="Comma-separated CODE=provider:model_id overrides.")
    parser.add_argument("--model-map-file", help="JSON file containing model-map overrides.")
    parser.set_defaults(parallel_dispatch_enabled=None, parallel_dispatch_max_concurrency=None)
    parser.add_argument(
        "--parallel-dispatch-enabled",
        dest="parallel_dispatch_enabled",
        action="store_true",
        help="Enable parallel dispatch for eligible rows.",
    )
    parser.add_argument(
        "--no-parallel-dispatch",
        dest="parallel_dispatch_enabled",
        action="store_false",
        help="Disable parallel dispatch.",
    )
    parser.add_argument(
        "--parallel-dispatch-max-concurrency",
        type=int,
        help="Maximum number of eligible workers to launch concurrently when parallel dispatch is enabled.",
    )
    parser.add_argument(
        "--template",
        action="append",
        default=[],
        help="Apply a saved dispatch template by name. Can be repeated.",
    )
    parser.add_argument(
        "--template-store",
        default=default_template_store_path(),
        help="Path to the dispatch template store. Overrides MERIDIAN_DISPATCH_TEMPLATE_STORE.",
    )
    parser.add_argument("--save-template", metavar="NAME", help="Save explicitly provided dispatcher flags as a template.")
    parser.add_argument("--list-templates", action="store_true", help="List saved dispatch templates and exit.")
    parser.add_argument("--show-template", metavar="NAME", help="Print one saved dispatch template and exit.")
    parser.add_argument("--delete-template", metavar="NAME", help="Delete one saved dispatch template and exit.")
    parser.add_argument("--dry-run", action="store_true", help="Print resolved payload without starting.")
    return parser


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = build_parser()
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    explicit_options = collect_explicit_option_dests(parser, raw_argv)
    args, unknown = parser.parse_known_args(raw_argv)

    dynamic_templates = parse_dynamic_template_flags(unknown)
    template_names = [*args.template, *dynamic_templates]
    template_store_path = resolve_path(args.template_store)
    template_store = load_template_store(template_store_path)
    apply_templates(args, template_names, template_store, explicit_options)

    args.explicit_option_dests = explicit_options
    args.template_store_path = template_store_path
    args.template_store_data = template_store
    args.templates_applied = template_names
    return args


def default_template_store_path() -> str:
    return os.environ.get(
        "MERIDIAN_DISPATCH_TEMPLATE_STORE",
        str(Path.home() / ".config" / "meridian" / "dispatch_templates.json"),
    )


def collect_explicit_option_dests(parser: argparse.ArgumentParser, argv: list[str]) -> set[str]:
    option_dests: dict[str, str] = {}
    for action in parser._actions:
        for option in action.option_strings:
            option_dests[option] = action.dest

    explicit: set[str] = set()
    for token in argv:
        if not token.startswith("-") or token == "-":
            continue
        option = token.split("=", 1)[0]
        dest = option_dests.get(option)
        if dest:
            explicit.add(dest)
    return explicit


def parse_dynamic_template_flags(unknown: list[str]) -> list[str]:
    template_names: list[str] = []
    for token in unknown:
        if not token.startswith("--") or token == "--" or "=" in token:
            raise DispatchError(f"Unknown argument: {token}", 2)
        name = token[2:]
        if not is_valid_template_name(name):
            raise DispatchError(f"Unknown option or dispatch template: {token}", 2)
        template_names.append(name)
    return template_names


def apply_templates(
    args: argparse.Namespace,
    template_names: list[str],
    store: dict[str, Any],
    explicit_options: set[str],
) -> None:
    templates = store["templates"]
    for name in template_names:
        settings = templates.get(name)
        if settings is None:
            raise DispatchError(f"Unknown option or dispatch template: --{name}", 2)
        validated = validate_template_settings(name, settings)
        for dest, value in validated.items():
            if template_dest_blocked_by_explicit(dest, explicit_options):
                continue
            setattr(args, dest, copy.deepcopy(value))


def template_dest_blocked_by_explicit(dest: str, explicit_options: set[str]) -> bool:
    if dest in explicit_options:
        return True
    for group in EXCLUSIVE_TEMPLATE_GROUPS:
        if dest in group and group.intersection(explicit_options):
            return True
    return False


def handle_template_management(args: argparse.Namespace) -> dict[str, Any] | None:
    requested = [dest for dest in TEMPLATE_MANAGEMENT_DESTS if getattr(args, dest)]
    if not requested:
        return None
    if len(requested) > 1:
        raise DispatchError("Use only one template management flag at a time.")

    store = args.template_store_data
    templates = store["templates"]
    store_path = args.template_store_path

    if args.list_templates:
        return {
            "ok": True,
            "action": "list_templates",
            "template_store": str(store_path),
            "templates": sorted(templates),
        }

    if args.show_template:
        name = require_template_name(args.show_template)
        if name not in templates:
            raise DispatchError(f"Dispatch template not found: {name}", 2)
        return {
            "ok": True,
            "action": "show_template",
            "template": name,
            "template_store": str(store_path),
            "settings": templates[name],
        }

    if args.delete_template:
        name = require_template_name(args.delete_template)
        if name not in templates:
            raise DispatchError(f"Dispatch template not found: {name}", 2)
        del templates[name]
        write_template_store(store_path, store)
        return {
            "ok": True,
            "action": "delete_template",
            "template": name,
            "template_store": str(store_path),
        }

    name = require_template_name(args.save_template)
    settings = collect_template_settings(args, args.explicit_option_dests)
    if not settings:
        raise DispatchError("No dispatcher settings were provided to save in the template.", 2)
    templates[name] = validate_template_settings(name, settings)
    write_template_store(store_path, store)
    return {
        "ok": True,
        "action": "save_template",
        "template": name,
        "template_store": str(store_path),
        "settings": templates[name],
    }


def collect_template_settings(args: argparse.Namespace, explicit_options: set[str]) -> dict[str, Any]:
    settings: dict[str, Any] = {}
    for dest in sorted(template_setting_dests()):
        if dest not in explicit_options:
            continue
        value = getattr(args, dest, None)
        if value is None:
            continue
        if dest in LIST_TEMPLATE_DESTS and not value:
            continue
        settings[dest] = copy.deepcopy(value)
    return settings


def template_setting_dests() -> set[str]:
    parser = build_parser()
    return {
        action.dest
        for action in parser._actions
        if action.option_strings and action.dest not in NON_TEMPLATE_DESTS
    }


def load_template_store(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": TEMPLATE_STORE_VERSION, "templates": {}}
    if not path.is_file():
        raise DispatchError(f"Dispatch template store is not a file: {path}")

    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise DispatchError(f"Invalid JSON in dispatch template store {path}: {error}") from error

    if not isinstance(parsed, dict):
        raise DispatchError("Dispatch template store must be a JSON object.")
    templates = parsed.get("templates")
    if not isinstance(templates, dict):
        raise DispatchError("Dispatch template store must contain a templates object.")

    validated_templates: dict[str, dict[str, Any]] = {}
    for name, settings in templates.items():
        validated_name = require_template_name(name)
        validated_templates[validated_name] = validate_template_settings(validated_name, settings)
    return {"version": TEMPLATE_STORE_VERSION, "templates": validated_templates}


def write_template_store(path: Path, store: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def validate_template_settings(name: str, settings: Any) -> dict[str, Any]:
    if not isinstance(settings, dict):
        raise DispatchError(f"Dispatch template {name} must be an object.")

    allowed = template_setting_dests()
    validated: dict[str, Any] = {}
    for dest, value in settings.items():
        if dest not in allowed:
            raise DispatchError(f"Dispatch template {name} contains unsupported setting: {dest}")
        validated[dest] = validate_template_value(name, dest, value)
    return validated


def validate_template_value(name: str, dest: str, value: Any) -> Any:
    if dest in BOOLEAN_TEMPLATE_DESTS:
        if not isinstance(value, bool):
            raise DispatchError(f"Dispatch template {name} setting {dest} must be boolean.")
        return value
    if dest in INTEGER_TEMPLATE_DESTS:
        if not isinstance(value, int) or isinstance(value, bool):
            raise DispatchError(f"Dispatch template {name} setting {dest} must be an integer.")
        if dest == "parallel_dispatch_max_concurrency" and value < 1:
            raise DispatchError(f"Dispatch template {name} setting {dest} must be at least 1.")
        return value
    if dest in FLOAT_TEMPLATE_DESTS:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise DispatchError(f"Dispatch template {name} setting {dest} must be a number.")
        return float(value)
    if dest == "reply_channel":
        if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
            raise DispatchError(f"Dispatch template {name} setting {dest} must be a non-empty string list.")
        return list(value)
    if dest in TEMPLATE_CHOICES:
        if not isinstance(value, str) or value not in TEMPLATE_CHOICES[dest]:
            choices = ", ".join(sorted(TEMPLATE_CHOICES[dest]))
            raise DispatchError(f"Dispatch template {name} setting {dest} must be one of: {choices}.")
        return value
    if not isinstance(value, str) or not value:
        raise DispatchError(f"Dispatch template {name} setting {dest} must be a non-empty string.")
    return value


def require_template_name(value: Any) -> str:
    if not isinstance(value, str) or not is_valid_template_name(value):
        raise DispatchError(
            "Dispatch template names must start with a letter or number and contain only letters, numbers, '-' or '_'.",
            2,
        )
    return value


def is_valid_template_name(value: str) -> bool:
    return bool(TEMPLATE_NAME_RE.fullmatch(value))


def resolve_artifacts(args: argparse.Namespace) -> dict[str, Path | None]:
    plan_path = resolve_plan_path(args)
    taskspec_dir = plan_path.parent
    command_path = resolve_command_path(args, taskspec_dir)

    return {
        "taskspec_dir": taskspec_dir,
        "plan_path": plan_path,
        "command_path": command_path,
    }


def resolve_plan_path(args: argparse.Namespace) -> Path:
    if args.plan:
        return require_file(resolve_path(args.plan), "dispatch plan")

    target_value = args.taskspec_dir or args.target or "."
    target = resolve_path(target_value)

    if target.is_file():
        if target.name == "dispatch_plan.md":
            return target
        if target.name in {"index.md", *COMMAND_FILE_CANDIDATES}:
            return require_file(target.parent / "dispatch_plan.md", "dispatch plan")
        raise DispatchError(f"Unsupported target file: {target}")

    if not target.exists():
        raise DispatchError(f"Target does not exist: {target}")
    if not target.is_dir():
        raise DispatchError(f"Target is not a directory or file: {target}")

    direct = target / "dispatch_plan.md"
    nested = target / "taskspec" / "dispatch_plan.md"
    if direct.exists():
        return require_file(direct, "dispatch plan")
    if nested.exists():
        return require_file(nested, "dispatch plan")

    raise DispatchError(
        "Could not find dispatch_plan.md. Pass a TaskSpec directory, a parent with taskspec/, or --plan."
    )


def resolve_command_path(args: argparse.Namespace, taskspec_dir: Path) -> Path:
    if args.command:
        return require_file(resolve_path(args.command), "command file")

    for file_name in COMMAND_FILE_CANDIDATES:
        candidate = taskspec_dir / file_name
        if candidate.exists():
            return require_file(candidate, "command file")

    raise DispatchError(
        f"Could not find command file beside {taskspec_dir}. Expected one of: "
        + ", ".join(COMMAND_FILE_CANDIDATES)
    )


def validate_dispatch_plan(plan_path: Path) -> list[dict[str, str]]:
    text = plan_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    for index, line in enumerate(lines[:-1]):
        header = parse_table_row(line)
        if not header:
            continue
        normalized = [normalize_header(cell) for cell in header]
        if not {"status", "batch", "worker"}.issubset(set(normalized)):
            continue
        separator = parse_table_row(lines[index + 1])
        if not separator or len(separator) != len(header) or not all(is_separator(cell) for cell in separator):
            continue

        rows: list[dict[str, str]] = []
        for row_number, row_line in enumerate(lines[index + 2 :], start=index + 3):
            cells = parse_table_row(row_line)
            if not cells:
                break
            if len(cells) != len(header):
                raise DispatchError(
                    f"Dispatch table row {row_number} has {len(cells)} cells; expected {len(header)}. "
                    "Remove literal pipe characters from table cells."
                )
            row = dict(zip(normalized, cells, strict=True))
            worker = row.get("worker", "").strip()
            if worker:
                rows.append(row)

        if not rows:
            raise DispatchError(f"Dispatch table in {plan_path} has no worker rows.")
        return rows

    raise DispatchError(f"No parseable dispatch table found in {plan_path}. Required columns: Status, Batch, Worker.")


def parse_table_row(line: str) -> list[str] | None:
    trimmed = line.strip()
    if not trimmed.startswith("|"):
        return None
    if trimmed.endswith("|"):
        trimmed = trimmed[:-1]
    return [cell.strip() for cell in trimmed[1:].split("|")]


def normalize_header(cell: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in cell).strip("_")


def is_separator(cell: str) -> bool:
    stripped = cell.replace(" ", "")
    return len(stripped) >= 3 and set(stripped) <= {"-", ":"}


def build_payload(args: argparse.Namespace, resolved: dict[str, Path | None], reply_channels: list[dict[str, Any]]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "dispatch_plan_path": str(resolved["plan_path"]),
        "command_file_path": str(resolved["command_path"]),
        "user_reply_channels": reply_channels,
        "agent_type": args.agent_type,
        "mode": args.mode,
        "kill_policy": args.kill_policy,
        "auto_approve": bool(args.auto_approve),
    }

    optional_fields = {
        "model_id": args.model_id,
        "credential_id": args.credential_id,
        "dispatch_repo_root": args.repo_root,
        "docs_root": args.docs_root,
    }
    for key, value in optional_fields.items():
        if value:
            payload[key] = str(resolve_path(value)) if key.endswith("_root") else value

    payload["validator"] = build_validator_config(args)
    payload["pm_resolver"] = build_pm_resolver_config(args, reply_channels)

    parallel_dispatch = build_parallel_dispatch_config(args)
    if parallel_dispatch is not None:
        payload["parallel_dispatch"] = parallel_dispatch

    model_map = resolve_model_map(args)
    if model_map:
        payload["config"] = {"model_map": model_map}

    return payload


def build_validator_config(args: argparse.Namespace) -> dict[str, Any]:
    if not args.validator_enabled:
        return {"enabled": False}

    config: dict[str, Any] = {
        "enabled": True,
        "agent_type": args.validator_agent_type,
        "mode": args.validator_mode,
        "auto_approve": bool(args.validator_auto_approve),
        "threshold_type": args.validator_threshold_type,
        "pass_threshold": args.validator_pass_threshold,
        "max_fix_cycles": args.validator_max_fix_cycles,
        "base_branch": args.validator_base_branch,
    }
    if args.validator_model_id:
        config["model_id"] = args.validator_model_id
    return config


def build_pm_resolver_config(args: argparse.Namespace, reply_channels: list[dict[str, Any]]) -> dict[str, Any]:
    if not args.pm_enabled:
        return {"enabled": False}

    config: dict[str, Any] = {
        "enabled": True,
        "agent_type": args.pm_agent_type,
        "mode": args.pm_mode,
        "auto_approve": bool(args.pm_auto_approve),
        "user_reply_channels": reply_channels,
    }
    if args.pm_model_id:
        config["model_id"] = args.pm_model_id
    return config


def build_parallel_dispatch_config(args: argparse.Namespace) -> dict[str, Any] | None:
    if args.parallel_dispatch_enabled is None and args.parallel_dispatch_max_concurrency is None:
        return None

    enabled = bool(args.parallel_dispatch_enabled) if args.parallel_dispatch_enabled is not None else True
    config: dict[str, Any] = {"enabled": enabled}
    if args.parallel_dispatch_max_concurrency is not None:
        if args.parallel_dispatch_max_concurrency < 1:
            raise DispatchError("--parallel-dispatch-max-concurrency must be at least 1.")
        config["max_concurrency"] = args.parallel_dispatch_max_concurrency
    return config


def resolve_model_map(args: argparse.Namespace) -> dict[str, dict[str, str]]:
    if args.model_map and args.model_map_file:
        raise DispatchError("Provide either --model-map or --model-map-file, not both.")

    if args.model_map_file:
        path = require_file(resolve_path(args.model_map_file), "model map file")
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise DispatchError(f"Invalid JSON in model map file {path}: {error}") from error
        return validate_model_map(parsed)

    if not args.model_map:
        return {}

    result: dict[str, dict[str, str]] = {}
    for entry in [part.strip() for part in args.model_map.split(",") if part.strip()]:
        if "=" not in entry or ":" not in entry.split("=", 1)[1]:
            raise DispatchError(f"Invalid --model-map entry: {entry}")
        code, rest = entry.split("=", 1)
        provider, model_id = rest.split(":", 1)
        if not code.strip() or not provider.strip() or not model_id.strip():
            raise DispatchError(f"Invalid --model-map entry: {entry}")
        result[code.strip()] = {"provider": provider.strip(), "model_id": model_id.strip()}
    return result


def validate_model_map(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        raise DispatchError("Model map JSON must be an object.")
    result: dict[str, dict[str, str]] = {}
    for code, override in value.items():
        if not isinstance(code, str) or not isinstance(override, dict):
            raise DispatchError("Model map entries must be CODE: {provider, model_id}.")
        provider = override.get("provider")
        model_id = override.get("model_id")
        if not isinstance(provider, str) or not provider or not isinstance(model_id, str) or not model_id:
            raise DispatchError(f"Invalid model map override for {code}.")
        result[code] = {"provider": provider, "model_id": model_id}
    return result


def resolve_reply_channels(args: argparse.Namespace, service_url: str) -> list[dict[str, Any]]:
    if args.reply_channels:
        try:
            parsed = json.loads(args.reply_channels)
        except json.JSONDecodeError as error:
            raise DispatchError(f"Invalid --reply-channels JSON: {error}") from error
        return validate_reply_channels(parsed)

    if args.reply_channel:
        return [parse_reply_channel(value) for value in args.reply_channel]

    if args.dry_run:
        return [DEFAULT_FALLBACK_REPLY_CHANNEL]

    try:
        response = request_json(service_url, "/api/channels", method="GET")
    except DispatchError as error:
        raise DispatchError(f"Could not discover reply channels: {error}", error.exit_code) from error

    channels = response.get("channels")
    if isinstance(channels, list) and channels:
        return validate_reply_channels(channels)
    return [DEFAULT_FALLBACK_REPLY_CHANNEL]


def parse_reply_channel(value: str) -> dict[str, Any]:
    stripped = value.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as error:
            raise DispatchError(f"Invalid --reply-channel JSON: {error}") from error
        return validate_reply_channel(parsed)

    if ":" not in stripped:
        raise DispatchError(f"Invalid --reply-channel shorthand: {value}")

    channel, suffix = stripped.split(":", 1)
    if not channel or not suffix:
        raise DispatchError(f"Invalid --reply-channel shorthand: {value}")
    return validate_reply_channel({"channel": channel, "chat_id": f"{channel}:{suffix}"})


def validate_reply_channels(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise DispatchError("Reply channels must be a non-empty JSON array.")
    return [validate_reply_channel(item) for item in value]


def validate_reply_channel(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DispatchError("Reply channel must be an object.")
    channel = value.get("channel")
    chat_id = value.get("chat_id")
    if channel not in {"telegram", "web", "socket"}:
        raise DispatchError(f"Invalid reply channel type: {channel}")
    if not isinstance(chat_id, str) or not chat_id:
        raise DispatchError("Reply channel chat_id is required.")
    return dict(value)


def request_json(service_url: str, path: str, method: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = service_url.rstrip("/") + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise DispatchError(f"{method} {url} failed with HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise DispatchError(f"Meridian-roles service unreachable at {service_url}: {error.reason}", 3) from error
    except TimeoutError as error:
        raise DispatchError(f"Meridian-roles service timed out at {service_url}", 3) from error
    except json.JSONDecodeError as error:
        raise DispatchError(f"{method} {url} returned invalid JSON: {error}") from error

    if not isinstance(payload, dict):
        raise DispatchError(f"{method} {url} returned non-object JSON.")
    return payload


def normalize_service_url(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        return DEFAULT_SERVICE_URL
    return stripped.rstrip("/")


def resolve_path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def require_file(path: Path, label: str) -> Path:
    if not path.exists():
        raise DispatchError(f"{label} does not exist: {path}")
    if not path.is_file():
        raise DispatchError(f"{label} is not a file: {path}")
    return path


if __name__ == "__main__":
    raise SystemExit(main())
