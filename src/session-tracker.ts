// Session tracker — discovers, monitors, and maintains state for all sessions

import { openSync, readSync, closeSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSessionFile, parseTail } from "./session-parser.js";
import { findPiProcesses, matchProcessesToSessions, isProcessAlive } from "./process-manager.js";
import type { TrackedSession, FilterMode, SortMode, SessionStatus } from "./types.js";
import { isAlive } from "./types.js";

const DEFAULT_SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

export interface SessionTrackerOptions {
  sessionDir?: string;
  cwdFilter?: string;
  pollIntervalMs?: number;
}

export class SessionTracker {
  private sessionDir: string;
  private cwdFilter: string | null;
  private pollIntervalMs: number;
  private sessions: Map<string, TrackedSession> = new Map();
  private fileTailOffsets: Map<string, number> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchers: ReturnType<typeof watch>[] = [];
  private onChange: (() => void) | null = null;

  constructor(options: SessionTrackerOptions = {}) {
    this.sessionDir = options.sessionDir ?? DEFAULT_SESSION_DIR;
    this.cwdFilter = options.cwdFilter ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
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

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.prompt.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.shortId.toLowerCase().includes(q) ||
          (s.name?.toLowerCase().includes(q) ?? false)
      );
    }

    list.sort((a, b) => {
      switch (sort) {
        case "newest":
          return b.startedAt.getTime() - a.startedAt.getTime();
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
          session.interactive = existing.interactive;
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
    const matches = matchProcessesToSessions(piProcs, this.sessionDir);

    // Build lookup: sessionFile → match info
    const matchByFile = new Map<string, { pid: number; interactive: boolean }>();
    const alivePids = new Set<number>();
    for (const m of matches) {
      matchByFile.set(m.sessionFile, { pid: m.pid, interactive: m.interactive });
      alivePids.add(m.pid);
    }

    for (const [filePath, session] of this.sessions) {
      const match = matchByFile.get(filePath);

      if (match) {
        // Process is alive and matched to this session
        session.pid = match.pid;
        session.interactive = match.interactive;

        if (!match.interactive) {
          session.status = "running";
        } else {
          this.updateActivityStatus(session, filePath);
        }
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
  }

  private updateActivityStatus(session: TrackedSession, _filePath: string): void {
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
