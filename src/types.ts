// Shared types for pi-dash

/**
 * Four session categories:
 *
 *   interactive-idle    — process alive, waiting for user input (last stop reason was "stop" or "aborted")
 *   interactive-active  — process alive, agent is working (streaming/tools)
 *   running             — process alive, agent is working (no stop reason yet)
 *   finished            — process exited (subcategories: done / failed / killed)
 */
export type SessionStatus =
  | "interactive-idle"
  | "interactive-active"
  | "running"
  | "done"
  | "failed"
  | "killed"
  | "unknown";

/** Is this a "live" (process running) status? */
export function isAlive(status: SessionStatus): boolean {
  return status === "interactive-idle" || status === "interactive-active" || status === "running";
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCost: number;
}

export interface TrackedSession {
  // Identity
  sessionId: string;
  shortId: string;
  sessionFile: string;
  cwd: string;

  // Display
  name: string | null;
  prompt: string;
  lastUserMessage: string | null;

  // Status
  status: SessionStatus;
  pid: number | null;
  startedAt: Date;
  endedAt: Date | null;
  duration: number | null;

  // Activity detection — tracks whether file is growing
  lastFileSize: number;
  fileGrowingSince: number | null; // timestamp of last observed growth, null if idle

  // Progress
  turnCount: number;
  userMessageCount: number;
  lastToolName: string | null;
  lastToolArgs: string | null;
  lastToolCallStartedAt: Date | null;
  lastSubagentArgs: any | null; // raw arguments from the last subagent toolCall
  lastAssistantStopReason: string | null; // most recent assistant stopReason
  model: string | null;
  provider: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  lastOutput: string | null; // last assistant text snippet

  // Cost
  totalUsage: SessionUsage;

  // Subagent info
  isSubagent: boolean;
  parentPid: number | null;
  agentName: string | null;

  // Peek buffer — raw JSONL lines for the peek view
  peekLines: string[];
}

export const MAX_PEEK_LINES = 500;

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role: string;
    content: any;
    provider?: string;
    model?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cost: { total: number };
    };
    stopReason?: string;
    errorMessage?: string;
  };
  name?: string;
  customType?: string;
  [key: string]: any;
}

export type SortMode = "newest" | "status" | "cwd" | "cost";
export type FilterMode = "all" | "interactive" | "running" | "finished";

export interface AppState {
  sessions: TrackedSession[];
  selectedIndex: number;
  selectedSessionId: string | null; // track by ID to survive refreshes
  filter: FilterMode;
  sort: SortMode;
  searchQuery: string;
  searchMode: boolean;
  searchMatchFiles: Set<string> | null; // null = no active search, Set = grep results
  pathFilter: string | null; // null = off, string = filter to this cwd
  view: "list" | "peek" | "help";
}
