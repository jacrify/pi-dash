# pi-dash: Process & Session Correlation

## The Problem

Pi doesn't keep session files open (it does atomic append-and-close per write).
This means we have no file handles to match. We have to reconstruct which
process owns which session from indirect signals.

## Signals Available

| Signal | Source | Reliability |
|--------|--------|-------------|
| Process exists | `ps` | ✓ Definitive |
| Process cwd | `lsof -d cwd` | ✓ Definitive |
| Process start time | `ps -o lstart` | ✓ Definitive |
| Session file creation time | Encoded in filename | ✓ Definitive |
| Session file mtime | `stat` | ✓ But shared-cwd ambiguity |
| Session file content | `.jsonl` entries | Tells us turns/errors/activity state |

## Process → Session Matching (`process-manager.ts`)

### Step 1: Find pi processes

`ps -eo pid,args` filtered for lines matching `pi` as a standalone command
or `node .../pi`. Returns PIDs.

### Step 2: Get cwds and stdin types (batched)

Single `lsof` call for all PIDs at once:
- `lsof -a -d cwd -p <pids>` → maps PID to working directory

### Step 3: Group by cwd, match to session files

Processes are grouped by their cwd. Each cwd maps to a session directory:

```
/Users/john/code → ~/.pi/agent/sessions/--Users-john-code--/
```

Encoding: strip leading `/`, replace `/` with `-`, wrap in `--...--`.

Within each cwd group, processes are matched to session files in two passes:

#### Pass 1: Timestamp matching (new sessions)

When `pi` starts a new session, it creates a file with the current timestamp
in the filename: `2026-04-14T20-47-23-836Z_<uuid>.jsonl`. We compare this to
the process start time from `ps -o lstart`.

Match criteria:
- Session file created **at most 60 seconds before** process start (startup delay)
- Session file created **at most 5 seconds after** process start (write delay)
- Closest match wins
- Already-claimed files are excluded

This handles the common case: `pi` or `pi -p "prompt"` creating a fresh session.

#### Pass 2: Recency matching (continued sessions)

`pi -c` (continue) reopens an existing session file — its creation timestamp
won't match the process start time. For these, we fall back to:

- File must have been modified **in the last 30 seconds**
- Most recently modified unclaimed file wins

The 30-second window prevents stale finished sessions from being grabbed. This
means a `pi -c` session will only be detected while it's actively writing (which
is fine — if it's idle for 30+ seconds, it'll briefly show as unmatched until
the next write).

**Known limitation**: if two `pi -c` processes in the same cwd are both writing
to different old session files simultaneously, the matching is ambiguous. In
practice this is rare.

### Unmatched processes

A pi process with no session file match is ignored (no session entry to update).
This can happen during startup before the first write, or for `--no-session` runs.

## Status Determination (`session-tracker.ts`)

### For live processes (matched to a session file)

Activity status is determined entirely from session file content — specifically
the last assistant message's `stopReason`:

| Condition | Status |
|-----------|--------|
| Process alive + last `stopReason` is `"stop"` or `"aborted"` | `interactive-idle` |
| Process alive + last `stopReason` is anything else (including `null`) | `interactive-active` |

**File growth detection**: each poll cycle (default 2s), we compare the session
file size to its size from the previous cycle. If it grew, the agent is actively
working. If it hasn't grown for 2+ poll intervals, the session is idle (waiting
for user input).

**Important**: `parseTail()` (which reads new session file content) never
overwrites status. An interim `stopReason: "error"` during a multi-turn agentic
loop does NOT flip a running session to "failed" — only process death triggers
finished-status resolution.

### For dead processes / unmatched sessions

| Condition | Status |
|-----------|--------|
| Session has `stopReason: "error"` or `errorMessage` | `failed` |
| Session has `stopReason: "stop"` | `done` |
| Session has neither + file age > 30s | `killed` |
| Session has neither + file age ≤ 30s | `unknown` (might still be starting) |

### Interactive flag preservation

_(Removed)_ The `interactive` boolean flag was previously set by checking
whether a process's stdin was a TTY via `lsof -d 0`. This was unreliable
(lsof failures defaulted to `true`, only valid while the process was alive)
and unnecessary — session activity state is now determined entirely from
the session log data (`stopReason`, `lastToolCallStartedAt`, etc.).

## Polling Architecture

```
Every 2 seconds:
  1. correlateProcesses()    — find pi PIDs, match to sessions, set statuses
  2. tailRunning()           — read new bytes from alive session files, parse entries
  3. notify()                — trigger TUI re-render
```

File watchers (`fs.watch`) on session directories catch new session files between
polls (for faster detection of new `pi` invocations).

## Edge Cases

| Case | Behavior |
|------|----------|
| `pi --no-session` | No session file created; process found but unmatched |
| `pi -c` reopening old session | Matched via 30s recency fallback |
| Multiple `pi` in same cwd | Timestamp matching disambiguates; unmatched processes ignored |
| Process dies between polls | Detected on next poll; status resolved from session content |
| Session file partially written | Incomplete trailing JSON line ignored; retried next poll |
| pi-dash itself shows as a process | Filtered out — `ps` pattern matches `pi` not `pi-dash` |
