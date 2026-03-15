---
name: meridian-onboard
description: Installs Meridian from GitHub main branch and runs an interactive onboarding flow, pausing to ask the user for crucial settings (Telegram bot token, allowed user IDs, optional env) until .env is configured and setup is complete. Use when the user wants to install Meridian, set up Meridian from scratch, or run Meridian onboarding.
---

# Meridian Onboarding

When executing this skill, install Meridian from GitHub and guide the user through configuration step by step. **Pause after each "Ask the user" step and do not continue until the user provides the requested information or explicitly skips.** Treat this as an interactive onboarding flow.

## Defaults

- **Clone URL**: `https://github.com/yzsnstotz/Meridian.git`
- **Branch**: `main`
- **Node**: ^22.0.0 (see `package.json` engines)

---

## Step 1: Where to install and which repo

**PAUSE and ask the user:**

- "Which directory should Meridian be installed into? (e.g. `~/work/Meridian` or current directory name `Meridian`)."
- "Use the default repo `https://github.com/yzsnstotz/Meridian.git` or provide a different GitHub repo URL?"

**After the user responds:**

- Set `INSTALL_DIR` to the chosen directory (resolve `~` and relative paths).
- Set `REPO_URL` to the chosen or default repo URL.
- If `INSTALL_DIR` already exists and contains a Meridian clone, ask: "Directory already exists. Use it as-is, or specify a different directory?"
- **Clone**: `git clone --branch main "$REPO_URL" "$INSTALL_DIR"` (or `cd "$INSTALL_DIR" && git fetch && git checkout main && git pull` if reusing existing dir).
- **Install deps**: `cd "$INSTALL_DIR" && npm install`.
- Then continue to Step 2.

---

## Step 2: Telegram bot token (required)

**PAUSE and ask the user:**

- "Do you have a Telegram bot token? If not: open Telegram, message @BotFather, run `/newbot`, follow the prompts, then paste the token here. If you already have one, paste it now."

**After the user provides a token:**

- Validate it is non-empty and looks like `\d+:[A-Za-z0-9_-]+`. If invalid, ask once more: "The token should be a long number, a colon, and a string (e.g. `123456789:ABC...`). Please paste the token from @BotFather."
- Store the value for `TELEGRAM_BOT_TOKEN`.
- Then continue to Step 3.

---

## Step 3: Allowed user IDs (required)

**PAUSE and ask the user:**

- "Who should be allowed to use the bot? Provide your Telegram user ID(s). You can get your ID by messaging @userinfobot in Telegram. Use comma-separated numbers for multiple users (e.g. `123456789` or `111,222,333`)."

**After the user provides ID(s):**

- Validate non-empty and numeric (comma-separated numbers only). If invalid, ask once more.
- Store the value for `ALLOWED_USER_IDS`.
- Then continue to Step 4.

---

## Step 4: Optional settings

**PAUSE and ask the user:**

- "Optional settings (you can skip by saying 'skip' or 'defaults'):"
  - "Extra Telegram bot tokens (comma-separated)?"
  - "Runtime mode: development | test | production (default: development)?"
  - "Log level: trace | debug | info | warn | error | fatal (default: debug)?"
  - "Default agent work directory for /spawn (AGENT_WORKDIR, e.g. /path/to/repo)?"
  - "Any API keys now (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, CURSOR_API_KEY)?"

**After the user responds:**

- Fill in only the values they provide; leave others as in `.env.example` or empty.
- Then continue to Step 5.

---

## Step 5: Create .env

- Copy `.env.example` to `.env` in `INSTALL_DIR` (if `.env` already exists, ask: "Overwrite existing .env? (yes/no)" and only overwrite if user says yes).
- Set in `.env`:
  - `TELEGRAM_BOT_TOKEN` = value from Step 2
  - `ALLOWED_USER_IDS` = value from Step 3
  - Any optional values from Step 4
- Leave unset optional vars as in `.env.example` (e.g. empty `TELEGRAM_BOT_TOKENS=`, `ANTHROPIC_API_KEY=`, etc.).
- Confirm to the user: "Created/updated `.env` with your token and allowed user IDs."
- Then continue to Step 6.

---

## Step 6: Post-install choice

**PAUSE and ask the user:**

- "What do you want to do next?"
  - **A)** Run locally for development: start hub, interface, and monitor (instructions below).
  - **B)** Prepare for production: run host setup (log/socket dirs), build, and optionally PM2 or Docker (instructions below).
  - **C)** Only install and config; I'll run services myself.

**After the user chooses:**

- **A)** Run:
  - `cd "$INSTALL_DIR" && npm run start:hub` (in background or separate terminal),
  - `npm run start:interface` (same),
  - `npm run start:monitor` (same).
  - Or use launchers: `user_scripts/install_Meridian/macos_install/meridian-start.command` (macOS) or `windows_install/meridian-start.bat` (Windows).
- **B)** Run:
  - `sudo "$INSTALL_DIR/scripts/setup-host.sh"` (or inform user to run it with sudo if agent cannot).
  - `cd "$INSTALL_DIR" && npm run build`.
  - Optionally: `pm2 start ecosystem.config.js` or Docker Compose steps from README; inform user of the exact commands.
- **C)** Summarize what was done and point to README for running services.

---

## Step 7: Slash commands (reminder)

Before finishing, remind the user to configure Telegram slash commands in @BotFather with `/setcommands` and the command list from the project README (spawn, kill, status, attach, approve, update, mupdate, list, help).

---

## Checklist (track progress)

```
Meridian onboarding:
- [ ] Step 1: Clone repo and npm install
- [ ] Step 2: TELEGRAM_BOT_TOKEN
- [ ] Step 3: ALLOWED_USER_IDS
- [ ] Step 4: Optional settings (or skip)
- [ ] Step 5: .env created/updated
- [ ] Step 6: Post-install (dev / prod / skip)
- [ ] Step 7: Remind /setcommands in @BotFather
```

---

## Rules

- **Never** guess or invent Telegram tokens or user IDs; always wait for the user.
- **Always** pause after each "PAUSE and ask the user" until the user replies or explicitly skips (e.g. "skip" for optional step).
- If the user says "continue" or "next" without a value where one is required (token, allowed IDs), ask again once for that value.
- Use non-interactive commands only (no `sudo` that prompts for password unless the user is present; if sudo is needed, output the exact command for the user to run).
