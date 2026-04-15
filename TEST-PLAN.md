# pi-dash Test Plan (Agent-Only)

## Overview

Testing strategy for the non-TUI modules of pi-dash, using Vitest with in-memory fixtures.

## Tiers

### Tier 1: Pure Unit Tests (highest ROI)

#### `session-parser.test.ts`
- **`processEntry` — user message**: Sets `prompt` on first user msg, `lastUserMessage` on subsequent, increments `userMessageCount`, clears `lastAssistantStopReason`
- **`processEntry` — assistant message**: Sets `model`, `provider`, accumulates `totalUsage`, increments `turnCount` on stopReason, captures `lastOutput`, `lastToolName`, `lastToolArgs`
- **`processEntry` — assistant with toolUse stop**: Sets `lastToolCallStartedAt`, `lastToolName`, `lastToolArgs`
- **`processEntry` — session_info**: Sets `name`
- **`processEntry` — model_change**: Updates `provider` and `model`
- **`parseTail`**: Appends to `peekLines` (capped at 500), calls `processEntry` for each line, updates `duration`
- **`parseSessionFile`**: Full parse of multi-line JSONL → correct `TrackedSession` including status derivation (`done`, `failed`, `unknown`)
- **`parseSessionFile` — edge cases**: Empty file → `null`, non-session header → `null`, malformed JSON lines skipped gracefully
- **`isAlive`**: Returns `true` for `interactive-idle`, `interactive-active`, `running`; `false` for `done`, `failed`, `killed`, `unknown`

### Tier 2: Integration Tests with Fixtures

#### `session-tracker.test.ts`
- **`fullScan` + `getFilteredSessions`**: Discovers all `.jsonl` files in temp session dir
- **`getFilteredSessions` — filter modes**: `interactive`, `running`, `finished` each return correct subset
- **`getFilteredSessions` — sort modes**: `newest`, `status`, `cwd`, `cost` produce correct ordering
- **`resolveFinishedStatus`**: Error → `failed`, stopReason `stop` → `done`, else → `killed`
- **`updateActivityStatus`**: `lastAssistantStopReason === "stop"` → `interactive-idle`, else → `interactive-active`
- **`tailRunning`**: After appending to a session file, tailing picks up new entries and updates the session

#### `process-manager.test.ts`
- **`matchProcessesToSessions`**: Given temp session dir with known `.jsonl` files and mock process list, matches correctly by timestamp proximity
- **`matchProcessesToSessions` — continue fallback**: When no timestamp match, falls back to most-recently-modified file
- **`matchProcessesToSessions` — multi-process same cwd**: Two processes, two session files, correctly assigns each
- **`isProcessAlive`**: Returns `true` for `process.pid`, `false` for a bogus PID

### Tier 3: CLI Smoke Tests

#### `cli.test.ts`
- **`--help`**: Exits 0, prints usage
- **`--json`**: Exits 0, outputs valid JSON array
- **`--list`**: Exits 0, outputs table header
- **`--json --session-dir <empty-tmpdir>`**: Outputs `[]`

## Test Infrastructure
- **Framework**: Vitest
- **Fixtures**: In-memory JSONL strings + temp directories via `mkdtempSync`
- **No mocking of OS commands** in Tier 1; Tier 2 uses temp dirs to avoid real session data
