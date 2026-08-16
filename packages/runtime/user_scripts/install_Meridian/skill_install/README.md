# Meridian Skill Install (Agent onboarding)

This folder contains the **meridian-onboard** skill so any coding agent can install and configure Meridian by following the skill. Load it into your agent using one of the methods below.

## Skill layout

```
skill_install/
└── meridian-onboard/
    └── SKILL.md
```

The skill is **Agent Skills**-compatible (see [agentskills.io](https://agentskills.io/)).

---

## Loading by platform

Use **relative paths** from the Meridian repo root. As long as the repo structure is unchanged (e.g. `user_scripts/install_Meridian/skill_install/` exists), these paths work.

### 1. Cursor (2.4+)

Cursor loads skills from:

| Location | Scope |
|----------|--------|
| `.agents/skills/` | Project (preferred) |
| `.cursor/skills/` | Project |
| `~/.cursor/skills/` | User/global |

**Option A – Project (recommended)**  
From repo root:

```bash
mkdir -p .agents/skills
cp -r user_scripts/install_Meridian/skill_install/meridian-onboard .agents/skills/
```

**Option B – Symlink (skill stays in repo)**  
From repo root:

```bash
mkdir -p .agents/skills
ln -s "$(pwd)/user_scripts/install_Meridian/skill_install/meridian-onboard" .agents/skills/meridian-onboard
```

**Option C – User-level**  
Copy once for all projects:

```bash
cp -r user_scripts/install_Meridian/skill_install/meridian-onboard ~/.cursor/skills/
```

Cursor also reads **compatibility paths**: `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`. You can put `meridian-onboard` in any of these with the same folder structure.

**Invoke:** Type `/meridian-onboard` in Agent chat, or let the agent apply it when it detects install/onboarding intent.

---

### 2. Claude Code (Claude desktop / IDE)

Skills live under `.claude/skills/` (project) or `~/.claude/skills/` (user). Each skill is a **directory** with a `SKILL.md` (or `.md` instructions).

**Project:**

```bash
mkdir -p .claude/skills
cp -r user_scripts/install_Meridian/skill_install/meridian-onboard .claude/skills/
```

**User:**

```bash
cp -r user_scripts/install_Meridian/skill_install/meridian-onboard ~/.claude/skills/
```

---

### 3. Codex

Uses `.codex/skills/` (project) or `~/.codex/skills/` (user). Same layout: one folder per skill with `SKILL.md`.

**Project:**

```bash
mkdir -p .codex/skills
cp -r user_scripts/install_Meridian/skill_install/meridian-onboard .codex/skills/
```

---

### 4. Windsurf

Windsurf uses **rules** (not skills) in `.windsurf/rules/`. Rules are Markdown; no standard `SKILL.md` frontmatter.

**Option A – Use as reference**  
Tell the agent: “Follow the Meridian onboarding steps in `user_scripts/install_Meridian/skill_install/meridian-onboard/SKILL.md`.”

**Option B – Add as a rule**  
Copy the instructions into a rule file:

```bash
mkdir -p .windsurf/rules
# Copy the body of SKILL.md into a .md file in .windsurf/rules/
```

---

### 5. Other agents (generic)

For any agent that supports “skill” or “rule” directories:

1. Find the agent’s skill/rule directory (e.g. `AGENT/skills/`, `AGENT/rules/`).
2. Copy the **entire** `meridian-onboard` folder there so the structure is `…/meridian-onboard/SKILL.md`.
3. Ensure the agent loads Markdown from that directory; frontmatter is optional but helps if supported.

If the agent expects a single file, use `meridian-onboard/SKILL.md` as the instruction set.

---

## Summary

| Agent / Platform | Directory (project) | Directory (user) |
|------------------|---------------------|------------------|
| Cursor 2.4+      | `.agents/skills/` or `.cursor/skills/` | `~/.cursor/skills/` |
| Claude Code      | `.claude/skills/`  | `~/.claude/skills/` |
| Codex            | `.codex/skills/`   | `~/.codex/skills/` |
| Windsurf         | `.windsurf/rules/` (adapt content) | — |
| Generic          | Agent’s skill/rule folder | — |

All paths above are relative to the Meridian repo root; keep `user_scripts/install_Meridian/` structure unchanged so scripts and links work.
