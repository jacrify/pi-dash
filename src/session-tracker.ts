// Session tracker — discovers, monitors, and maintains state for all sessions

import { openSync, readSync, closeSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";

function aLastActivity(s: TrackedSession): number {
  try {
    return statSync(s.sessionFile).mtimeMs;
  } catch {
    return s.startedAt.getTime();
  }
}
import { parseSessionFile, parseTail } from "./session-parser.js";
import { findPiProcesses, matchProcessesToSessions, isProcessAlive, type UnmatchedPiProcess } from "./process-manager.js";
import type { TrackedSession, FilterMode, SortMode, SessionStatus } from "./types.js";
import { isAlive } from "./types.js";

const DEFAULT_SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

export interface SessionTrackerOptions {
  sessionDir?: string;
  cwdFilter?: string;
  pollIntervalMs?: number;
  searchDays?: number;
}

export class SessionTracker {
  private sessionDir: string;
  private cwdFilter: string | null;
  private pollIntervalMs: number;
  private searchDays: number;
  private sessions: Map<string, TrackedSession> = new Map();
  private fileTailOffsets: Map<string, number> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchers: ReturnType<typeof watch>[] = [];
  private onChange: (() => void) | null = null;
  private grepProc: ChildProcess | null = null;

  constructor(options: SessionTrackerOptions = {}) {
    this.sessionDir = options.sessionDir ?? DEFAULT_SESSION_DIR;
    this.cwdFilter = options.cwdFilter ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.searchDays = options.searchDays ?? 30;
  }

  start(onChange: () => void): void {
    this.onChange = onChange;
    this.fullScan();
    this.correlateProcesses();
    this.startPolling();
    this.startWatching();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];
  }

  getSessions(): TrackedSession[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s }));
  }

  getFilteredSessions(filter: FilterMode, sort: SortMode, search: string): TrackedSession[] {
    let list = this.getSessions();

    if (this.cwdFilter) {
      list = list.filter((s) => s.cwd.startsWith(this.cwdFilter!));
    }

    if (filter === "interactive") {
      list = list.filter((s) => s.status === "interactive-idle" || s.status === "interactive-active");
    } else if (filter === "running") {
      list = list.filter((s) => s.status === "running");
    } else if (filter === "finished") {
      list = list.filter((s) => s.status === "done" || s.status === "failed" || s.status === "killed");
    }

    // search filtering is handled externally via searchFiles() + searchMatchFiles
    void search;

    list.sort((a, b) => {
      switch (sort) {
        case "newest": {
          const aTime = aLastActivity(a);
          const bTime = aLastActivity(b);
          return bTime - aTime;
        }
        case "status": {
          const order: Record<SessionStatus, number> = {
            "running": 0,
            "interactive-active": 1,
            "interactive-idle": 2,
            "unknown": 3,
            "failed": 4,
            "killed": 5,
            "done": 6,
          };
          const diff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
          if (diff !== 0) return diff;
          return b.startedAt.getTime() - a.startedAt.getTime();
        }
        case "cwd":
          return a.cwd.localeCompare(b.cwd);
        case "cost":
          return b.totalUsage.totalCost - a.totalUsage.totalCost;
        default:
          return 0;
      }
    });

    return list;
  }

  /**
   * Get session file paths that are within the search-days window.
   * Uses file mtime which is already stat'd during scan.
   */
  private getCandidateFiles(): string[] {
    const cutoff = Date.now() - this.searchDays * 24 * 60 * 60 * 1000;
    const files: string[] = [];
    for (const [filePath, session] of this.sessions) {
      // Use mtime from the file — we already stat these during scan
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime >= cutoff) {
          files.push(filePath);
        }
      } catch {
        // File gone, skip
      }
    }
    return files;
  }

  /**
   * Search session files for a query string using grep.
   * Kills any in-flight grep. Returns matching file paths via callback.
   */
  searchFiles(query: string, callback: (matchingFiles: Set<string>) => void): void {
    // Kill any in-flight grep
    if (this.grepProc) {
      this.grepProc.kill();
      this.grepProc = null;
    }

    if (!query) {
      callback(new Set());
      return;
    }

    const candidateFiles = this.getCandidateFiles();
    if (candidateFiles.length === 0) {
      callback(new Set());
      return;
    }

    // Spawn grep -Fil with file list via xargs to avoid ARG_MAX
    const proc = spawn("xargs", ["grep", "-Fil", query], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.grepProc = proc;

    let stdout = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      if (proc !== this.grepProc && this.grepProc !== null) {
        // A newer search superseded this one
        return;
      }
      this.grepProc = null;
      const files = new Set(
        stdout.trim().split("\n").filter(Boolean)
      );
      callback(files);
    });

    // Write file list to stdin, one per line
    proc.stdin!.write(candidateFiles.join("\n") + "\n");
    proc.stdin!.end();
  }

  refresh(): void {
    this.fullScan();
    this.correlateProcesses();
    this.notify();
  }

  // --- Internal ---

  private fullScan(): void {
    let subdirs: string[];
    try {
      subdirs = readdirSync(this.sessionDir);
    } catch {
      return;
    }

    for (const subdir of subdirs) {
      const dirPath = join(this.sessionDir, subdir);
      let files: string[];
      try {
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) continue;
        files = readdirSync(dirPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(dirPath, file);

        const existing = this.sessions.get(filePath);
        if (existing && !isAlive(existing.status) && existing.status !== "unknown") {
          continue;
        }

        const session = parseSessionFile(filePath);
        if (!session) continue;

        // Preserve process info from existing tracking
        if (existing) {
          session.pid = existing.pid;
          session.fileGrowingSince = existing.fileGrowingSince;
          if (isAlive(existing.status)) {
            session.status = existing.status;
          }
        }

        this.sessions.set(filePath, session);

        try {
          this.fileTailOffsets.set(filePath, statSync(filePath).size);
        } catch {}
      }
    }
  }

  /**
   * Correlate processes with session files using timestamp-based matching,
   * then determine the four status categories.
   */
  private correlateProcesses(): void {
    const piProcs = findPiProcesses();
    const { matches, unmatched } = matchProcessesToSessions(piProcs, this.sessionDir);

    // Build lookup: sessionFile → match info
    const matchByFile = new Map<string, { pid: number }>();
    const alivePids = new Set<number>();
    for (const m of matches) {
      matchByFile.set(m.sessionFile, { pid: m.pid });
      alivePids.add(m.pid);
    }

    // Also track alive subagent pids
    for (const u of unmatched) {
      alivePids.add(u.pid);
    }

    for (const [filePath, session] of this.sessions) {
      const match = matchByFile.get(filePath);

      if (match) {
        // Process is alive and matched to this session
        session.pid = match.pid;
        this.updateActivityStatus(session, filePath);
      } else if (session.pid && !isProcessAlive(session.pid)) {
        // Process we were tracking died
        session.pid = null;
        this.resolveFinishedStatus(session);
      } else if (session.pid && !alivePids.has(session.pid)) {
        // PID still alive but no longer matched (shouldn't happen, but be safe)
        session.pid = null;
        this.resolveFinishedStatus(session);
      } else if (!session.pid && isAlive(session.status)) {
        // Was alive but no process found
        session.pid = null;
        this.resolveFinishedStatus(session);
      } else if (session.status === "unknown") {
        const age = Date.now() - session.startedAt.getTime();
        if (age > 30000) {
          this.resolveFinishedStatus(session);
        }
      }
    }

    // Handle subagent processes (--no-session) — create/update synthetic sessions.
    // Include processes whose parent (ppid) is ANY known pi process
    // (matched or not), since the parent may not always match its session
    // file on every poll cycle due to mtime thresholds.
    const allPiPids = new Set(piProcs.map(p => p.pid));
    this.reconcileSubagents(unmatched, alivePids, allPiPids);
  }

  private updateActivityStatus(session: TrackedSession, _filePath: string): void {
    // Subagents are always "active" while their process runs
    if (session.isSubagent) {
      session.status = "interactive-active";
      return;
    }
    // The reliable signal is the last assistant stop reason:
    // - "stop" means the agent finished its turn → waiting for user input
    // - anything else ("toolUse", null, etc.) means the agent is still working
    // "stop" = agent finished its turn, "aborted" = user ctrl+c'd the response
    // Both mean the session is waiting for user input
    if (session.lastAssistantStopReason === "stop" || session.lastAssistantStopReason === "aborted") {
      session.status = "interactive-idle";
    } else {
      session.status = "interactive-active";
    }
  }

  /**
   * Create/update synthetic TrackedSession entries for --no-session subagent processes.
   * Remove entries for subagents whose process has exited.
   */
  private reconcileSubagents(
    unmatched: UnmatchedPiProcess[],
    alivePids: Set<number>,
    allPiPids: Set<number>,
  ): void {
    const subagentKey = (pid: number) => `__subagent__${pid}`;

    // Track which subagent keys are still alive
    const aliveKeys = new Set<string>();

    for (const proc of unmatched) {
      // Only treat as subagent if parent is any known pi process
      if (!allPiPids.has(proc.ppid)) continue;

      const key = subagentKey(proc.pid);
      aliveKeys.add(key);

      if (this.sessions.has(key)) {
        // Already tracked — update status and current tool from child processes
        const existing = this.sessions.get(key)!;
        existing.status = "interactive-active";
        this.updateSubagentTool(existing);
        continue;
      }

      // Look up parent session to get agent name and task from its subagent toolCall
      let agentName: string | null = null;
      let task: string | null = null;
      let parentToolStartedAt: Date | null = null;
      for (const [, parentSession] of this.sessions) {
        if (parentSession.isSubagent) continue;
        if (parentSession.pid !== proc.ppid) continue;
        if (parentSession.lastSubagentArgs) {
          const args = parentSession.lastSubagentArgs;
          // Single mode: { agent, task }
          if (args.agent && args.task) {
            agentName = args.agent;
            task = args.task;
          }
          // Parallel mode: { tasks: [{agent, task}, ...] }
          // Chain mode: { chain: [{agent, task}, ...] }
          // We can't match which parallel task corresponds to which PID,
          // but show the agent name(s) at least
          if (!agentName && args.tasks?.length) {
            const agents = [...new Set(args.tasks.map((t: any) => t.agent))];
            agentName = agents.join(",");
            if (args.tasks.length === 1) task = args.tasks[0].task;
          }
          if (!agentName && args.chain?.length) {
            const agents = [...new Set(args.chain.map((t: any) => t.agent))];
            agentName = agents.join("→");
          }
          parentToolStartedAt = parentSession.lastToolCallStartedAt;
        }
        break;
      }

      // Create synthetic session
      const session: TrackedSession = {
        sessionId: `subagent-${proc.pid}`,
        shortId: String(proc.pid),
        sessionFile: key, // synthetic key, not a real file
        cwd: proc.cwd ?? "",
        name: null,
        prompt: task ? task.slice(0, 200) : "(subagent)",
        lastUserMessage: task ? task.slice(0, 200) : null,
        status: "interactive-active",
        pid: proc.pid,
        startedAt: proc.startTime ? new Date(proc.startTime) : new Date(),
        endedAt: null,
        duration: null,
        lastFileSize: 0,
        fileGrowingSince: null,
        turnCount: 0,
        userMessageCount: 0,
        lastToolName: agentName ?? "subagent",
        lastToolArgs: task ? task.slice(0, 80) : null,
        lastToolCallStartedAt: proc.startTime ? new Date(proc.startTime) : new Date(),
        lastSubagentArgs: null,
        lastAssistantStopReason: null,
        model: null,
        provider: null,
        stopReason: null,
        errorMessage: null,
        lastOutput: null,
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 },
        isSubagent: true,
        parentPid: proc.ppid,
        agentName, // We can't easily get agent name from args
        peekLines: [],
      };

      this.sessions.set(key, session);
      this.updateSubagentTool(session);
    }

    // Remove subagent entries whose process has exited
    for (const [key, session] of this.sessions) {
      if (!session.isSubagent) continue;
      if (!aliveKeys.has(key)) {
        this.sessions.delete(key);
      }
    }
  }

  /**
   * Detect what tool a subagent is currently running by inspecting its child processes.
   * Uses the child process start time for accurate elapsed tracking.
   */
  private updateSubagentTool(session: TrackedSession): void {
    if (!session.pid) return;
    try {
      const output = execSync(
        `ps -o pid,lstart,args= -p $(pgrep -P ${session.pid} 2>/dev/null | tr '\n' ',')0 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 }
      );
      const result = parseChildProcessPs(output);
      if (result) {
        session.lastToolName = "bash";
        session.lastToolArgs = result.args;
        session.lastToolCallStartedAt = result.startedAt;
      }
    } catch {
      // No children or pgrep failed
    }
  }

  private resolveFinishedStatus(session: TrackedSession): void {
    if (session.errorMessage || session.stopReason === "error") {
      session.status = "failed";
    } else if (session.stopReason === "stop") {
      session.status = "done";
    } else {
      session.status = "killed";
    }
  }

  private tailRunning(): void {
    for (const [filePath, session] of this.sessions) {
      if (!isAlive(session.status)) continue;

      const prevOffset = this.fileTailOffsets.get(filePath) ?? 0;
      let currentSize: number;
      try {
        currentSize = statSync(filePath).size;
      } catch {
        continue;
      }

      if (currentSize <= prevOffset) continue;

      try {
        const fd = openSync(filePath, "r");
        const buf = Buffer.alloc(currentSize - prevOffset);
        readSync(fd, buf, 0, buf.length, prevOffset);
        closeSync(fd);

        const newContent = buf.toString("utf-8");
        const newLines = newContent.split("\n").filter((l: string) => l.trim());
        if (newLines.length > 0) {
          parseTail(session, newLines);
          this.fileTailOffsets.set(filePath, currentSize);
        }
      } catch {}
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.correlateProcesses();
      this.tailRunning();
      this.notify();
    }, this.pollIntervalMs);
  }

  private startWatching(): void {
    try {
      const subdirs = readdirSync(this.sessionDir);
      for (const subdir of subdirs) {
        const dirPath = join(this.sessionDir, subdir);
        try {
          const w = watch(dirPath, (eventType: string, filename: string | null) => {
            if (filename?.endsWith(".jsonl")) {
              const filePath = join(dirPath, filename);
              if (!this.sessions.has(filePath)) {
                const session = parseSessionFile(filePath);
                if (session) {
                  this.sessions.set(filePath, session);
                  try {
                    this.fileTailOffsets.set(filePath, statSync(filePath).size);
                  } catch {}
                  this.correlateProcesses();
                  this.notify();
                }
              }
            }
          });
          this.watchers.push(w);
        } catch {}
      }

      const topWatcher = watch(this.sessionDir, (eventType: string, filename: string | null) => {
        if (eventType === "rename" && filename) {
          this.refresh();
        }
      });
      this.watchers.push(topWatcher);
    } catch {}
  }

  private notify(): void {
    this.onChange?.();
  }
}

/**
 * Parse `ps -o pid,lstart,args=` output to find the most interesting child process.
 * Returns the command args and start time, or null if nothing useful found.
 * Exported for testing.
 */
export function parseChildProcessPs(output: string): { args: string; startedAt: Date } | null {
  for (const line of output.trim().split("\n").reverse()) {
    // lstart format on macOS: "Wed 15 Apr 13:59:06 2026"
    const match = line.trim().match(/^(\d+)\s+(\w{3}\s+\d+\s+\w{3}\s+[\d:]+\s+\d{4})\s+(.+)$/);
    if (!match) continue;
    const lstart = match[2]!;
    const args = match[3]!;
    // Skip node/pi processes themselves
    if (/^(node|pi)\s/.test(args) || args === "pi") continue;
    const startTime = new Date(lstart).getTime();
    if (!isNaN(startTime)) {
      return { args: args.slice(0, 80), startedAt: new Date(startTime) };
    }
  }
  return null;
}
