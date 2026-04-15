# pi-dash

A terminal dashboard for monitoring [pi](https://github.com/mariozechner/pi) coding agent sessions.

![Status](https://img.shields.io/badge/status-alpha-orange)

## What it does

pi-dash gives you a unified view of all your pi sessions — running, waiting, finished, or failed — in a single terminal UI. It works by monitoring pi's session files (`~/.pi/agent/sessions/`) and correlating them with live processes.

```
pi-dash  │ 3 running │ 2 waiting │ 12 done │ 1 failed │        ? help
  STATUS         ID    AGE      DIRECTORY              LAST TOOL                TASK
  ▶ running      #a3f2 4s       ~/code                 bash 3m02s               Fix the auth bug in log...
  ● active       #c8b1 2s       ~/api                  read 1s                  Add rate limiting to...
  ◉ waiting      #d4e2 35s      ~/code                 bash                     Refactor the database...
> ✓ done         #b1c4 12m      ~/code                 bash                     Add unit tests for...
  ✗ failed       #e7d9 45m      ~/api                  bash                     Deploy the hotfix...
  ◼ killed       #f0a1 2h03m    ~/code                 bash                     Refactor database...
──────────────────────────────────────────────────────────────────────────────────────────────────────
 Session #b1c4 — Done (1m 02s)
 Model: claude-sonnet-4-5 (anthropic)
 CWD: /Users/john/code
 Prompt: "Add unit tests for the auth module"
 Turns: 5 │ Tokens: 18,200 in / 4,100 out │ Cost: $0.06
 Last tool: bash npm test
```

### Session statuses

| Icon | Status | Meaning |
|------|--------|---------|
| `▶` | running | Agent is working (no stop reason yet) |
| `●` | active | Agent is working (streaming or running tools) |
| `◉` | waiting | Waiting for user input |
| `✓` | done | Completed successfully |
| `✗` | failed | Ended with error |
| `◼` | killed | Process died without clean exit |

### Columns

| Column | Description |
|--------|-------------|
| STATUS | Session status icon and label |
| ID | Short session ID (first 4 chars) |
| AGE | Time since the session file was last written to (ticks live) |
| DIRECTORY | Working directory of the session |
| LAST TOOL | Last tool called, with elapsed time if still running |
| TASK | Session name, last user message, or initial prompt |

### Keybindings

| Key | Action |
|-----|--------|
| `↑`/`k` `↓`/`j` | Navigate sessions |
| `Enter`/`p` | Peek — live scrollable event log |
| `K` | Kill selected session (SIGTERM) |
| `f` | Cycle filter: all → interactive → running → finished |
| `s` | Cycle sort: newest → status → cwd → cost |
| `/` | Search by prompt, cwd, or session ID |
| `r` | Force refresh |
| `?` | Help |
| `q`/`Esc` | Quit (or exit peek) |

## Install

```bash
git clone https://github.com/jacrify/pi-dash.git
cd pi-dash
npm install
npm run build
```

## Usage

```bash
# Launch the dashboard
node dist/main.js

# Filter to a specific project
node dist/main.js --cwd /path/to/project

# Show only running sessions
node dist/main.js --filter running
```

## How it works

pi always writes structured JSONL to session files regardless of mode (`-p`, interactive, etc.). pi-dash:

1. **Scans** `~/.pi/agent/sessions/` for all `.jsonl` files
2. **Correlates** live `pi` processes to session files via `ps` + `lsof` (matching process start times to file creation timestamps)
3. **Determines activity** using the last assistant message's `stopReason` — `"stop"` or `"aborted"` means waiting for user input, anything else means the agent is working
4. **Tails** active session files for real-time updates

### Subagent support

pi-dash detects subagent processes spawned by pi's built-in [subagent extension](https://github.com/badlogic/pi-mono/tree/main/examples/extensions/subagent). Subagents run with `--no-session` so they don't create session files — pi-dash discovers them by finding unmatched `pi` processes whose parent is a tracked session. For each subagent it shows:

- The agent name and task (extracted from the parent session's toolCall)
- The currently running child process (e.g. `bash sleep 30`) with elapsed time, detected via `ps` on the subagent's child processes
- Process start time for accurate age tracking

Subagent entries appear with a `⊂` prefix in the status column and are automatically removed when the process exits.

See [HEURISTICS.md](HEURISTICS.md) for the full process-correlation and status-detection logic.

## Requirements

- macOS or Linux
- Node.js 18+
- [pi](https://github.com/mariozechner/pi) coding agent

## License

MIT
