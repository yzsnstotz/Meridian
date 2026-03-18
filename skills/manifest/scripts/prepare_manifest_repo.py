#!/usr/bin/env python3

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional


HOSTS_YML = Path("/Users/yzliu/.config/gh/hosts.yml")
ACCOUNT_KEY = "clawso-manifest-gen"
DEFAULT_DEST_ROOT = Path("/tmp/manifest-skill")
DEFAULT_GITHUB_LOGIN = "nobuaki8366"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def load_account_token(hosts_path: Path, account_key: str) -> str:
    text = hosts_path.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^\s{{4}}{re.escape(account_key)}:\s*$.*?^\s{{6}}oauth_token:\s*(\S+)\s*$",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        raise SystemExit(f"Could not find oauth_token for account '{account_key}' in {hosts_path}")
    return match.group(1).strip()


def parse_repo_url(repo_url: str) -> tuple[str, str]:
    value = repo_url.strip()
    if value.startswith("git@github.com:"):
        value = "https://github.com/" + value[len("git@github.com:") :]
    if value.startswith("github.com/"):
        value = "https://" + value

    parsed = urllib.parse.urlparse(value)
    if parsed.netloc.lower() != "github.com":
        raise SystemExit("Only github.com repositories are supported")

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise SystemExit("Repo URL must include owner and repo")

    owner = parts[0]
    repo = parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    return owner, repo


def slugify(value: str) -> str:
    lowered = value.lower()
    lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered).strip("-")
    return lowered or "tool"


def api_request(
    token: str,
    method: str,
    path: str,
    body: Optional[dict] = None,
    accepted=(200, 201, 202),
):
    url = "https://api.github.com" + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        method=method,
        data=data,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "clawso-manifest-skill",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
            data = json.loads(payload) if payload else None
            if response.status not in accepted:
                raise SystemExit(f"GitHub API {response.status} for {path}")
            return data, response.status
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            data = {"message": payload}
        if error.code not in accepted:
            raise SystemExit(f"GitHub API {error.code} for {path}: {data.get('message', payload)}")
        return data, error.code


def resolve_github_login(token: str) -> str:
    data, _status = api_request(token, "GET", "/user", accepted=(200,))
    login = (data or {}).get("login")
    if not login:
        raise SystemExit(
            f"Could not resolve GitHub login for account key '{ACCOUNT_KEY}'. "
            f"Expected the token to belong to '{DEFAULT_GITHUB_LOGIN}'."
        )
    return login


def get_source_repo(token: str, source_owner: str, source_repo: str):
    try:
        repo, _status = api_request(token, "GET", f"/repos/{source_owner}/{source_repo}", accepted=(200,))
        return repo
    except SystemExit as error:
        message = str(error)
        if "GitHub API 404" in message:
            raise SystemExit(
                f"Source repo '{source_owner}/{source_repo}' returned 404 on GitHub. "
                "Stop here and ask the user to verify the exact owner/repo path; do not guess."
            ) from error
        raise


def ensure_fork(token: str, source_owner: str, source_repo: str, fork_owner: str):
    fork_path = f"/repos/{fork_owner}/{source_repo}"
    try:
        repo, _status = api_request(token, "GET", fork_path, accepted=(200,))
        return repo
    except SystemExit:
        pass

    repo, status = api_request(
        token,
        "POST",
        f"/repos/{source_owner}/{source_repo}/forks",
        body={"default_branch_only": False},
        accepted=(200, 202),
    )
    if status == 202:
        for _attempt in range(12):
            time.sleep(2)
            try:
                repo, _status = api_request(token, "GET", fork_path, accepted=(200,))
                return repo
            except SystemExit:
                continue
        raise SystemExit("Fork creation accepted by GitHub but fork did not become available in time")
    return repo


def run(cmd, cwd=None):
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def clone_or_refresh_repo(clone_url: str, dest_dir: Path, full_clone: bool, default_branch: str):
    if dest_dir.exists():
        if (dest_dir / ".git").exists():
            run(["git", "fetch", "--all", "--prune", "--depth=1"], cwd=dest_dir)
            run(["git", "checkout", default_branch], cwd=dest_dir)
            run(["git", "reset", "--hard", f"origin/{default_branch}"], cwd=dest_dir)
            return
        shutil.rmtree(dest_dir)

    dest_dir.parent.mkdir(parents=True, exist_ok=True)
    clone_cmd = ["git", "clone", "--depth=1"]
    if not full_clone:
        clone_cmd.extend(["--filter=blob:none", "--sparse"])
    clone_cmd.extend([clone_url, str(dest_dir)])
    run(clone_cmd)


def get_default_branch(repo_data: dict) -> str:
    return repo_data.get("default_branch") or "main"


def main():
    parser = argparse.ArgumentParser(description="Fork and clone a repo for clawso manifest adaptation")
    parser.add_argument("repo_url", help="Source GitHub repo URL")
    parser.add_argument("--dest-root", default=str(DEFAULT_DEST_ROOT), help="Local clone parent directory")
    parser.add_argument("--slug", default=None, help="Explicit clawso slug override")
    parser.add_argument("--entry-point", default="clawso/index.js", help="Suggested manifest entry point")
    parser.add_argument("--timeout-seconds", type=int, default=25, help="Suggested timeout_seconds")
    parser.add_argument("--allowed-host", action="append", dest="allowed_hosts", default=[], help="Suggested allowed_hosts entries")
    parser.add_argument(
        "--full-clone",
        action="store_true",
        help="Clone the full repo instead of the default shallow sparse clone",
    )
    args = parser.parse_args()

    token = load_account_token(HOSTS_YML, ACCOUNT_KEY)
    fork_owner = resolve_github_login(token)
    source_owner, source_repo = parse_repo_url(args.repo_url)
    log(f"Resolved source repo: {source_owner}/{source_repo}")
    log(f"Resolved GitHub login for '{ACCOUNT_KEY}': {fork_owner}")

    source_repo_data = get_source_repo(token, source_owner, source_repo)
    source_default_branch = get_default_branch(source_repo_data)
    log(f"Ensuring fork under {fork_owner}/{source_repo}")
    fork_repo_data = ensure_fork(token, source_owner, source_repo, fork_owner)

    dest_root = Path(args.dest_root)
    dest_dir = dest_root / fork_owner / source_repo

    clone_url = f"https://x-access-token:{token}@github.com/{fork_owner}/{source_repo}.git"
    log(
        f"{'Refreshing' if dest_dir.exists() else 'Cloning'} fork to {dest_dir} "
        f"({'full' if args.full_clone else 'shallow+sparse'})"
    )
    clone_or_refresh_repo(clone_url, dest_dir, args.full_clone, source_default_branch)
    run(["git", "remote", "set-url", "origin", f"https://github.com/{fork_owner}/{source_repo}.git"], cwd=dest_dir)
    run(["git", "branch", "--set-upstream-to", f"origin/{source_default_branch}", source_default_branch], cwd=dest_dir)
    upstream_url = f"https://github.com/{source_owner}/{source_repo}.git"
    remotes = subprocess.run(
        ["git", "remote"],
        cwd=dest_dir,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if "upstream" not in remotes:
        run(["git", "remote", "add", "upstream", upstream_url], cwd=dest_dir)

    slug = args.slug or slugify(source_repo_data.get("name") or source_repo)
    title = source_repo_data.get("name") or source_repo
    description = source_repo_data.get("description") or ""

    result = {
        "source": {
            "owner": source_owner,
            "repo": source_repo,
            "html_url": source_repo_data.get("html_url"),
            "default_branch": source_repo_data.get("default_branch"),
            "license": (source_repo_data.get("license") or {}).get("spdx_id"),
            "description": description,
        },
        "fork": {
            "account_key": ACCOUNT_KEY,
            "owner": fork_owner,
            "repo": source_repo,
            "html_url": fork_repo_data.get("html_url"),
            "clone_dir": str(dest_dir),
            "source_url_for_clawso": fork_repo_data.get("html_url"),
            "package_url_for_clawso": f"https://api.github.com/repos/{fork_owner}/{source_repo}/zipball",
        },
        "suggested_manifest": {
            "slug": slug,
            "title": title,
            "description": description,
            "entry_point": args.entry_point,
            "timeout_seconds": args.timeout_seconds,
            "allowed_hosts": args.allowed_hosts,
        },
    }
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
