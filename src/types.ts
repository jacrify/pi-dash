// Shared types for pi-dash

/**
 * Four session categories:
 *
 *   interactive-idle    — interactive session, process alive, waiting for user input
 *   interactive-active  — interactive session, process alive, agent is working (streaming/tools)
 *   running             — non-interactive (-p), process alive, agent is working
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

  // Status
  status: SessionStatus;
  pid: number | null;
  interactive: boolean | null;  // true = interactive, false = -p, null = never observed
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
  lastAssistantStopReason: string | null; // most recent assistant stopReason
  model: string | null;
  provider: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  lastOutput: string | null; // last assistant text snippet

  // Cost
  totalUsage: SessionUsage;

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
  view: "list" | "peek" | "help";
  peekScrollOffset: number;
  peekAutoScroll: boolean;
}
