# Meridian Web GUI — Function Checklist

Use this list to verify all GUI functions work (desktop and mobile).

## Hub (index.html)

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| View instance list | ✓ | ✓ | Cards with thread_id, agent, status, mode, created_at |
| New Session (toolbar button) | ✓ | — | Hidden on small viewport |
| FAB "New Session" | — | ✓ | Floating action button, bottom-right |
| Pull-to-refresh | — | ✓ | Pull down at top to refresh list |
| Click card → open terminal | ✓ | ✓ | Navigate to terminal.html?thread_id=…&token=… |
| Auth: show error when no token | ✓ | ✓ | Message + `?token=YOUR_TOKEN` |

## Terminal / Agent (terminal.html)

### Header

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Back button → index | ✓ | ✓ | Returns to hub |
| Menu (hamburger) | — | ✓ | Opens sidebar (Files explorer) |
| Thread badge | ✓ | ✓ | Shows thread_id or "No session" |
| Reboot / Kill buttons | ✓ | — | In header right |
| Overflow "..." menu | — | ✓ | Opens dropdown: Reboot, Kill |
| Live status indicator | ✓ | ✓ | Green dot + "Live" |

### Main area — Tabs (desktop)

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Terminal tab | ✓ | — | xterm.js pane, pane_output streamed |
| Editor tab | ✓ | — | File content + Save |

### Main area — Views (mobile)

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Chat view (default on mobile) | — | ✓ | Agent output as bubbles; placeholder when empty |
| Editor view | — | ✓ | Bottom nav "Editor" → editor panel |
| Pane / agent output in chat | ✓ | ✓ | WebSocket pane_output → chat bubbles |
| Typing indicator | ✓ | ✓ | "Agent is responding..." while streaming |
| Option buttons (1. 2. …) | ✓ | ✓ | Rendered from agent output, tap to send |
| Yes/No buttons | ✓ | ✓ | When agent asks y/n |

### Input

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Text input | ✓ | ✓ | Placeholder: "Ask agent or run command..." |
| Send button | ✓ | ✓ | Submit message; Enter (no Shift) submits |
| Auto-resize textarea | ✓ | ✓ | Grows up to 120px |

### Sidebar (Files)

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Open sidebar | ✓ | ✓ | Menu (mobile) or always visible (desktop) |
| Close sidebar | ✓ | ✓ | Overlay click or open again (menu) |
| Files list | ✓ | ✓ | From `find . -maxdepth 2` |
| Refresh files | ✓ | ✓ | Button in sidebar header |
| Click file → Editor | ✓ | ✓ | Load file via run `cat`, show in Editor |
| Save (Editor) | ✓ | ✓ | Writes content back via run |

### Bottom nav (mobile only)

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Chat | — | ✓ | Switch to chat view |
| Editor | — | ✓ | Switch to editor view |
| Files | — | ✓ | Open sidebar (same as menu) |

### Actions

| Function | Desktop | Mobile | Notes |
|----------|---------|--------|-------|
| Reboot | ✓ | ✓ | Desktop: header; mobile: overflow "..." |
| Kill | ✓ | ✓ | Desktop: header; mobile: overflow "..." → back to index |

## Quick mobile verification order

1. Open hub (index) → see list or empty state; FAB and pull-to-refresh work.
2. Open a session (terminal.html) → thread badge shows; Chat view visible with placeholder if no output yet.
3. Menu (hamburger) → sidebar opens; Files list loads; overlay tap closes.
4. "..." in header → dropdown opens; Reboot / Kill work.
5. Type in input, tap SEND → message appears as user bubble; agent output appears when pane sends data.
6. Bottom nav: Editor → Editor view; Files → sidebar.
7. Sidebar: click a file → Editor shows content; Save works.
