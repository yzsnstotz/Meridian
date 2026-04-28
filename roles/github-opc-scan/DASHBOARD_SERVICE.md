# github-opc-scan Dashboard Service

The dashboard is a long-running local service, not a per-cycle scheduler worker. Start it manually during development, or install the launchd plist below for a persistent macOS service.

## Manual Start

```bash
github-ai-automation-scan dashboard \
  --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
  --output-dir /Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output \
  --host 127.0.0.1 \
  --port 18765
```

## launchd

The sample plist lives at:

```text
roles/github-opc-scan/launchd/com.yzsnstotz.github-opc-scan-dashboard.plist
```

Install or refresh it for the current user:

```bash
mkdir -p "${HOME}/Library/LaunchAgents"
cp roles/github-opc-scan/launchd/com.yzsnstotz.github-opc-scan-dashboard.plist "${HOME}/Library/LaunchAgents/"
launchctl unload "${HOME}/Library/LaunchAgents/com.yzsnstotz.github-opc-scan-dashboard.plist" 2>/dev/null || true
launchctl load "${HOME}/Library/LaunchAgents/com.yzsnstotz.github-opc-scan-dashboard.plist"
launchctl start com.yzsnstotz.github-opc-scan-dashboard
```

Logs:

- stdout: `/tmp/github-opc-scan-dashboard.out.log`
- stderr: `/tmp/github-opc-scan-dashboard.err.log`
