# whoport

A lightweight macOS menu bar app (Tauri + React) that answers one question:
**who is holding that port?** It lists every TCP port currently in LISTEN state
and shows which application owns it — name, PID, full executable path, and user.

Useful when you forget which app you left running on a port.

## How it works

- `lsof -nP -iTCP -sTCP:LISTEN` finds listening TCP ports and their owning PID.
- `ps -p <pids> -o pid=,comm=` resolves each PID to its full executable path
  (lsof truncates long process names, so the path comes from `ps`).
- The Rust backend merges both into one row per port and returns it to the UI.

## Features

- Live table: Port, Protocol (IPv4/IPv6), Application, PID, User, Path
- Filter box (matches port, app name, path, user, address)
- Sort by port / app / PID / user
- `system` / `user` badge per row so you can tell macOS daemons (risky to kill)
  from your own apps. A process is flagged `system` when it runs as `root` or a
  `_`-prefixed daemon user, or lives under `/System`, `/usr/bin`, `/usr/sbin`,
  `/usr/libexec`, `/sbin`, `/bin` (Homebrew and `/usr/local` count as user).
- Kill a process from its row (SIGTERM, Alt+click = SIGKILL) with a per-row
  loading state, a stronger confirmation for system processes, and a toast
  reporting success / still-running / failure.
- Menu bar resident: closing the window hides it instead of quitting; the app
  has no Dock icon and stays in the menu bar until you choose Quit. Left-click
  the tray icon to reopen; right-click for Open / Refresh / Quit.

## Develop

```bash
npm install
npm run tauri dev
```

## Build a distributable .app

```bash
npm run tauri build
```

The signed/unsigned `.app` and `.dmg` land in
`src-tauri/target/release/bundle/`.

## Requirements

- Rust (stable) + Xcode Command Line Tools
- Node 18+
