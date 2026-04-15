# pi-dash — Terminal Dashboard for `pi -p` Sessions

## Overview

A terminal TUI app that monitors, displays, and manages all `pi -p` (print-mode) sessions — both currently running and previously completed. No special flags required: pi always writes structured JSONL entries to its session files (`~/.pi/agent/sessions/`) regardless of `--mode`. We monitor those files directly.

## Problem

When running multiple `pi -p` tasks across terminal tabs or scripts, there's no unified view of:
- Which tasks are running, queued, succeeded, or failed
- What each task is doing right now
- How to kill a hung task or peek at its live output
- Historical task results

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   pi-dash TUI                   │
│                                                 │
│  ┌─ Session List ─────────────────────────────┐ │
│  │ ● #a3f2  Running   /code    "Fix auth bug" │ │
│  │ ✓ #b1c4  Done      /code    "Add tests"    │ │
│  │ ✗ #e7d9  Failed    /api     "Deploy fix"   │ │
│  │ ◼ #f0a1  Killed    /code    "Refactor DB"  │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─ Detail Pane ──────────────────────────────┐ │
│  │ Session #a3f2 — Running (2m 14s)           │ │
│  │ Model: claude-sonnet-4-5 / anthropic       │ │
│  │ CWD: /Users/john/code                      │ │
│  │ Prompt: "Fix the auth bug in login.ts"     │ │
│  │ Turns: 3 | Tokens: 12,450 in / 3,200 out  │ │
│  │ Last tool: bash `npm test`                 │ │
│  │ Cost: $0.042                               │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Components

```
pi-dash
├── src/
│   ├── main.ts              # Entry point, CLI arg parsing
│   ├── session-tracker.ts   # Core: discovers, monitors, correlates sessions
│   ├── process-manager.ts   # Spawn, kill, signal pi -p processes
│   ├── session-parser.ts    # Wraps pi SDK SessionManager for entry parsing
│   ├── session-store.ts     # In-memory state store for all tracked sessions
│   ├── tui/
│   │   ├── app.ts           # Top-level TUI layout & keybinding router
│   │   ├── session-list.ts  # Scrollable session list with status indicators
│   │   ├── detail-pane.ts   # Session detail / peek view
│   │   └── modals.ts        # Confirm kill, filter, etc.
│   └── types.ts             # Shared types
├── package.json
└── tsconfig.json
```

### Tech Stack

- **TypeScript** (ESM)
- **`@mariozechner/pi-coding-agent`** — SDK for session parsing, types, and `SessionManager` API (no reimplementation needed)
- **[Ink](https://github.com/vadimdemedes/ink)** — React-based terminal UI
- **chokidar** — file watcher for session directory changes
- **`node:child_process`** — for `lsof`/`ps` process correlation and kill signals

## Data Model

### TrackedSession

```typescript
interface TrackedSession {
  // Identity
  sessionId: string;           // UUID from session header
  shortId: string;             // First 4 chars of sessionId
  sessionFile: string;         // Absolute path to .jsonl file
  cwd: string;                 // Working directory from session header

  // Display
  name: string | null;         // From session_info entry, or null
  prompt: string;              // First user message (truncated)

  // Status
  status: "running" | "done" | "failed" | "killed" | "unknown";
  pid: number | null;          // OS process ID if running
  startedAt: Date;             // From session header timestamp
  endedAt: Date | null;        // From agent_end event timestamp
  duration: number | null;     // Milliseconds

  // Progress (live-updated from JSON events)
  turnCount: number;
  lastEvent: AgentSessionEvent | null;
  lastToolName: string | null;
  lastToolArgs: any | null;
  model: string | null;        // e.g. "claude-sonnet-4-5"
  provider: string | null;     // e.g. "anthropic"
  stopReason: string | null;   // From final assistant message
  errorMessage: string | null;

  // Cost tracking
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalCost: number;          // USD
  };

  // Peek buffer — last N events for live viewing
  eventBuffer: AgentSessionEvent[];  // Ring buffer, max 500 events
}
```

## Discovery & Monitoring

### Key Insight: Session Files Are the Source of Truth

Pi **always** writes structured JSONL entries to session files regardless of output mode (`--mode text`, `--mode json`, or interactive). The `--mode` flag only controls stdout formatting — the session `.jsonl` file format is identical in all cases. This means pi-dash works with any `pi -p` invocation, no special flags needed.

### How Sessions Are Found

Two complementary discovery mechanisms running in parallel:

#### 1. Session File Scanning (historical + running)

- On startup, scan `~/.pi/agent/sessions/*/` for all `.jsonl` files
- Parse session header (line 1) for metadata
- Walk entries to determine status:
  - Has `agent_end` event → **done** or **failed** (check last assistant `stopReason`)
  - No `agent_end` → could be **running** or **crashed**
- Cross-reference with running processes (see below)
- Watch directories with `chokidar` for new files and modifications

#### 2. Process Table Correlation (running)

- Periodically poll `ps` (every 2s) for running `pi` processes
- For each pi process, determine its session file by:
  - Reading `/proc/<pid>/fd/` (Linux) or `lsof -p <pid>` (macOS) to find open `.jsonl` file handles
  - Matching the session file to our tracked sessions
- Sessions with a matching live process → **running**
- Sessions with no `agent_end` and no matching process → **killed** / **crashed**

#### 3. Session File Tailing (for running sessions)

- For sessions detected as **running**, tail the `.jsonl` session file from the last known byte offset
- Parse each new line as a session entry (these are the same structured entries described in session.md)
- Update `TrackedSession` state in real-time
- On `agent_end` message entry: mark as **done** or **failed**, stop tailing

### Status Determination Logic

```
if has agent_end event:
  if last assistant stopReason == "error":
    status = "failed"
  else:
    status = "done"
else if matching pi process alive:
  status = "running"
else if session file age < 30s:
  status = "unknown"    # might still be starting
else:
  status = "killed"     # no process, no agent_end
```

## TUI Specification

### Layout

```
┌── Header Bar ─────────────────────────────────────────────┐
│ pi-dash  │ 3 running │ 12 done │ 1 failed │ ? help       │
├── Session List (top 60%) ─────────────────────────────────┤
│ [status] [shortId] [age/duration] [cwd]  [prompt]         │
│  ● #a3f2  2m14s  ~/code    Fix the auth bug in log...     │
│  ● #c8b1  45s    ~/api     Add rate limiting to...        │
│> ✓ #b1c4  1m02s  ~/code    Add unit tests for...          │
│  ✗ #e7d9  3m30s  ~/api     Deploy the hotfix...           │
│  ◼ #f0a1  0m12s  ~/code    Refactor database...           │
├── Detail Pane (bottom 40%) ───────────────────────────────┤
│ Session #b1c4 — Done (1m 02s)                             │
│ File: ~/.pi/agent/sessions/--Users-john-code--/2026-...   │
│ CWD: /Users/john/code                                     │
│ Model: claude-sonnet-4-5 (anthropic)                      │
│ Prompt: "Add unit tests for the auth module"              │
│ Turns: 5 │ Tokens: 18,200 in / 4,100 out │ Cost: $0.06   │
│ Stop: stop │ No errors                                    │
│                                                           │
│ Last activity:                                            │
│  tool_execution_end: bash `npm test` → exit 0             │
│  message_end: assistant "All tests passing..."            │
│  agent_end                                                │
└───────────────────────────────────────────────────────────┘
```

### Status Icons

| Icon | Status    | Color   |
|------|-----------|---------|
| `●`  | Running   | Green   |
| `✓`  | Done      | Cyan    |
| `✗`  | Failed    | Red     |
| `◼`  | Killed    | Yellow  |
| `?`  | Unknown   | Gray    |

### Keybindings

| Key         | Action                                                  |
|-------------|---------------------------------------------------------|
| `↑` / `k`  | Move selection up                                       |
| `↓` / `j`  | Move selection down                                     |
| `Enter`     | Toggle peek mode (full-screen live event stream)        |
| `p`         | Peek — open scrollable event log for selected session   |
| `K`         | Kill — send SIGTERM to selected running session         |
| `Shift+K`   | Force kill — SIGKILL                                    |
| `d`         | Delete — remove completed session file (with confirm)   |
| `f`         | Filter — toggle filter bar (running/done/failed/all)    |
| `s`         | Sort — cycle sort: newest first, status, cwd, cost      |
| `/`         | Search — fuzzy filter by prompt text or cwd             |
| `r`         | Refresh — force re-scan session directories             |
| `c`         | Copy session file path to clipboard                     |
| `o`         | Open session file in `$EDITOR`                          |
| `q` / `Esc` | Quit (from peek: return to list)                        |
| `?`         | Help overlay                                            |

### Peek Mode

Full-screen scrollable view of the session's JSON event stream, rendered human-readably:

```
━━ Peek: #a3f2 — Running (2m 14s) ━━━━━━━━━━━━━━━━━━━━━━━━

[06:08:01] agent_start
[06:08:01] turn_start
[06:08:01] message_start (user)
           "Fix the auth bug in login.ts where..."
[06:08:02] message_start (assistant)
[06:08:02] text_delta: "I'll fix the auth bug. Let me first..."
[06:08:03] tool_execution_start: read {path: "src/login.ts"}
[06:08:03] tool_execution_end: read (ok, 142 lines)
[06:08:04] text_delta: "I see the issue. The token..."
[06:08:04] tool_execution_start: edit {path: "src/login.ts"}
[06:08:04] tool_execution_end: edit (ok)
[06:08:05] tool_execution_start: bash {command: "npm test"}
[06:08:06] tool_execution_update: bash "Running tests..."
           ░░░░░░░░ (streaming...)

━━ [q] back │ [↑↓] scroll │ [G] bottom │ [K] kill ━━━━━━━━
```

**Rendering rules for peek:**
- `text_delta` events: accumulate and display as flowing text, dimmed
- `tool_execution_start`: show tool name + summarized args (file paths, first 60 chars of commands)
- `tool_execution_end`: show success/error + brief result summary
- `turn_end`: separator line with turn number
- `agent_end`: bold "DONE" / "FAILED" banner
- Timestamps shown as `HH:MM:SS` relative to local time
- Auto-scroll to bottom for running sessions (toggle with `F` to freeze)

## CLI Interface

```bash
# Launch the dashboard
pi-dash

# Launch filtered to a specific project directory
pi-dash --cwd /Users/john/code

# Launch showing only running sessions
pi-dash --filter running

# Custom session directory
pi-dash --session-dir ~/.pi/agent/sessions

# Non-interactive: list sessions as JSON (for scripting)
pi-dash --json

# Non-interactive: list sessions as table
pi-dash --list
```

### Arguments

| Flag                    | Default                     | Description                          |
|-------------------------|-----------------------------|--------------------------------------|
| `--cwd <path>`         | (all projects)              | Filter to sessions from this cwd     |
| `--filter <status>`    | `all`                       | Filter: running, done, failed, all   |
| `--session-dir <path>` | `~/.pi/agent/sessions`      | Session storage root                 |
| `--json`               |                             | Output session list as JSON, exit    |
| `--list`               |                             | Output session list as table, exit   |
| `--watch`              |                             | With --list/--json: keep updating    |
| `--poll-interval <ms>` | `2000`                      | Process table poll interval          |

## Implementation Notes

### Session File Parsing Strategy

Don't load entire session files into memory. For the session list:
1. Read line 1 (header) for `id`, `cwd`, `timestamp`
2. Read last ~20 lines for recent events and final status
3. Scan for `session_info` entries (session name) — these are rare, near end
4. Only in peek mode: stream the full file

### Process Correlation on macOS

```bash
# Find open .jsonl files for a pi process
lsof -p <pid> 2>/dev/null | grep '\.jsonl'
```

This is the most reliable way since `ps` args don't always show the session file path.

### Handling Concurrent Writes

Session `.jsonl` files are append-only. Safe to read while pi is writing because:
- Each line is a complete JSON object
- Partial lines at EOF should be ignored (retry on next poll)
- Use `fs.watch` or `chokidar` for change notifications, then read new bytes from last known offset

### Cost Calculation

Accumulate `usage.cost.total` from each `message` session entry where `message.role === "assistant"`. The `Usage` object on assistant messages contains full cost breakdowns.

### Performance Targets

- Startup scan of 1000 session files: < 2 seconds
- Running session event latency (file change → TUI update): < 200ms  
- Process table poll: every 2 seconds (configurable)
- Memory: < 50MB for 1000 tracked sessions with 500-event peek buffers

## Non-Goals (v1)

- **Launching** new `pi -p` tasks from the dashboard (future: `n` key to spawn)
- **Editing/re-running** failed sessions
- **Remote** session monitoring (SSH/network)
- **Notifications** (desktop/sound on completion)
- **Grouping** sessions by project (just sort/filter by cwd for now)

## Future Considerations (v2+)

- Launch tasks: `n` key opens prompt input, spawns `pi -p --mode json "<prompt>"` as child process
- Task queue: define a batch of prompts, run N in parallel
- Webhook/callback on completion
- Session diffing: show what files changed
- Cost budget alerts
- tmux/terminal multiplexer integration
