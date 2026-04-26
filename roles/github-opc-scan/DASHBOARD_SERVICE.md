# github-opc-scan Dashboard Service

The dashboard is a long-running local service, not a per-cycle scheduler worker. Keep it running with the sample macOS `launchd` plist at:

```text
roles/github-opc-scan/launchd/com.yzsnstotz.github-opc-scan-dashboard.plist
```

## Install

```bash
mkdir -p "${HOME}/Library/LaunchAgents"
cp /Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/launchd/com.yzsnstotz.github-opc-scan-dashboard.plist \
  "${HOME}/Library/LaunchAgents/com.yzsnstotz.github-opc-scan-dashboard.plist"
launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/com.yzsnstotz.github-opc-scan-dashboard.plist"
launchctl enable "gui/$(id -u)/com.yzsnstotz.github-opc-scan-dashboard"
launchctl kickstart -k "gui/$(id -u)/com.yzsnstotz.github-opc-scan-dashboard"
```

## Inspect

```bash
launchctl print "gui/$(id -u)/com.yzsnstotz.github-opc-scan-dashboard"
tail -f /tmp/github-opc-scan-dashboard.out.log
tail -f /tmp/github-opc-scan-dashboard.err.log
```

The sample plist binds the dashboard to `127.0.0.1:18765`.

## Stop

```bash
launchctl bootout "gui/$(id -u)" "${HOME}/Library/LaunchAgents/com.yzsnstotz.github-opc-scan-dashboard.plist"
```
