# Install Meridian

Three ways to install and run Meridian. **All paths are relative to the Meridian repo root.** As long as this folder structure is unchanged (`user_scripts/install_Meridian/` with the three subfolders), scripts and launchers work from anywhere.

## Layout

```
install_Meridian/
├── README.md           (this file)
├── skill_install/      Agent skill: load into Cursor / Claude / Codex / etc.
│   ├── README.md       How to load the skill per platform
│   └── meridian-onboard/
│       └── SKILL.md
├── macos_install/      macOS: installer + double-click launcher
│   ├── install.sh
│   └── meridian-start.command
└── windows_install/    Windows: installer + double-click launcher
    ├── install.bat
    └── meridian-start.bat
```

## 1. Skill install (any coding agent)

Use the **meridian-onboard** skill so an agent can install Meridian interactively (clone, ask for token and user IDs, create `.env`).

- See **[skill_install/README.md](skill_install/README.md)** for loading instructions for:
  - Cursor (`.agents/skills/` or `.cursor/skills/`)
  - Claude Code (`.claude/skills/`)
  - Codex (`.codex/skills/`)
  - Windsurf (`.windsurf/rules/`)
  - Generic agents

Paths in that README are relative to the repo root.

## 2. macOS install

From the Meridian repo root:

```bash
./user_scripts/install_Meridian/macos_install/install.sh
```

Then start Meridian by double-clicking:

```
user_scripts/install_Meridian/macos_install/meridian-start.command
```

Or from terminal: `./user_scripts/install_Meridian/macos_install/meridian-start.command`

## 3. Windows install

From the Meridian repo root (e.g. after clone):

```cmd
user_scripts\install_Meridian\windows_install\install.bat
```

Then start Meridian by double-clicking:

```
user_scripts\install_Meridian\windows_install\meridian-start.bat
```

## Relative paths

- **macos_install**: scripts assume repo root = `../../..` from the script file (e.g. `install_Meridian/macos_install/install.sh` → three levels up = repo root).
- **windows_install**: same with `..\..\..` from the batch file.
- **skill_install**: no runtime paths; copy/symlink instructions in `skill_install/README.md` use paths relative to the repo root.

Do not rename or move `user_scripts/install_Meridian/` or its subfolders if you want these commands to keep working.
