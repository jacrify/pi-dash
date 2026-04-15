// Process manager — finds running pi processes, detects mode, correlates with session files

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export interface PiProcess {
  pid: number;
  cwd: string | null;
  interactive: boolean;
}

export interface ProcessSessionMatch {
  pid: number;
  sessionFile: string;
  interactive: boolean;
}

const DEFAULT_SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * Find all running pi processes with their cwds and interactive mode.
 */
export function findPiProcesses(): PiProcess[] {
  const pids = findPiPids();
  if (pids.length === 0) return [];

  const cwds = getPidCwds(pids);
  const interactiveMap = getInteractiveStatus(pids);

  return pids.map((pid) => ({
    pid,
    cwd: cwds.get(pid) ?? null,
    interactive: interactiveMap.get(pid) ?? true,
  }));
}

/**
 * Match pi processes to session files.
 *
 * Strategy: group processes by cwd. For each cwd, find the session directory
 * and match each process to the session file whose creation timestamp is
 * closest to (but not after) the process's start time. If that's ambiguous,
 * fall back to file that's most recently modified and not yet claimed.
 */
export function matchProcessesToSessions(
  processes: PiProcess[],
  sessionDir?: string
): ProcessSessionMatch[] {
  const dir = sessionDir ?? DEFAULT_SESSION_DIR;
  const matches: ProcessSessionMatch[] = [];
  const startTimes = getProcessStartTimes(processes.map((p) => p.pid));

  // Group processes by cwd
  const byCwd = new Map<string, PiProcess[]>();
  for (const proc of processes) {
    if (!proc.cwd) continue;
    const group = byCwd.get(proc.cwd) ?? [];
    group.push(proc);
    byCwd.set(proc.cwd, group);
  }

  for (const [cwd, procs] of byCwd) {
    const encoded = "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
    const dirPath = join(dir, encoded);

    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    // Get file info: creation time from filename timestamp, mtime from stat
    const fileInfos = files.map((f) => {
      const fullPath = join(dirPath, f);
      const createdAt = parseFilenameTimestamp(f);
      let mtime = 0;
      try {
        mtime = statSync(fullPath).mtimeMs;
      } catch {}
      return { path: fullPath, createdAt, mtime };
    });

    // Sort processes by start time (newest first)
    const sortedProcs = [...procs].sort((a, b) =>
      (startTimes.get(b.pid) ?? 0) - (startTimes.get(a.pid) ?? 0)
    );

    const claimed = new Set<string>();

    for (const proc of sortedProcs) {
      const procStart = startTimes.get(proc.pid) ?? 0;

      // Find best match: session created just before or at process start,
      // not already claimed by another process
      let best: { path: string; score: number } | null = null;

      for (const fi of fileInfos) {
        if (claimed.has(fi.path)) continue;

        if (fi.createdAt && procStart) {
          // Session should be created around when the process started
          // Allow session to be created up to 30s before process (startup delay)
          // and up to 5s after (race condition)
          const diff = fi.createdAt - procStart;
          if (diff > 5000) continue; // session created way after process — not ours
          if (diff < -60000) continue; // session created >60s before process — probably not ours

          const score = -Math.abs(diff); // closer to 0 = better
          if (!best || score > best.score) {
            best = { path: fi.path, score };
          }
        }
      }

      // Fallback for `pi -c` (continue): session file was created long ago but
      // is being actively modified RIGHT NOW. Only match files modified in the
      // last 30 seconds to avoid grabbing stale files.
      if (!best) {
        const recentThreshold = Date.now() - 30000;
        let bestMtime = 0;
        for (const fi of fileInfos) {
          if (claimed.has(fi.path)) continue;
          // File must have been modified very recently
          if (fi.mtime < recentThreshold) continue;
          if (fi.mtime > bestMtime) {
            bestMtime = fi.mtime;
            best = { path: fi.path, score: -Infinity };
          }
        }
      }

      if (best) {
        claimed.add(best.path);
        matches.push({
          pid: proc.pid,
          sessionFile: best.path,
          interactive: proc.interactive,
        });
      }
    }
  }

  return matches;
}

/**
 * Parse the timestamp from a session filename.
 * Format: 2026-04-14T20-47-23-836Z_uuid.jsonl
 * Returns epoch ms or null.
 */
function parseFilenameTimestamp(filename: string): number | null {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec, ms] = match;
  const iso = `${year}-${month}-${day}T${hour}:${min}:${sec}.${ms}Z`;
  return new Date(iso).getTime();
}

/**
 * Get process start times using ps.
 */
function getProcessStartTimes(pids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (pids.length === 0) return result;

  try {
    // lstart gives full start timestamp
    const output = execSync(
      `ps -p ${pids.join(",")} -o pid,lstart= 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    );
    for (const line of output.trim().split("\n")) {
      const trimmed = line.trim();
      const pidMatch = trimmed.match(/^(\d+)\s+(.+)$/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1]!, 10);
        const startTime = new Date(pidMatch[2]!).getTime();
        if (!isNaN(startTime)) {
          result.set(pid, startTime);
        }
      }
    }
  } catch {}

  return result;
}

// --- PID discovery ---

function findPiPids(): number[] {
  try {
    const output = execSync(
      `ps -eo pid,args 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    );
    const pids: number[] = [];
    for (const line of output.trim().split("\n")) {
      const trimmed = line.trim();
      if (/^\d+\s+pi(\s|$)/.test(trimmed) || /^\d+\s+node\s+.*\/pi[\s]/.test(trimmed)) {
        const match = trimmed.match(/^(\d+)/);
        if (match) pids.push(parseInt(match[1]!, 10));
      }
    }
    return pids;
  } catch {
    return [];
  }
}

// --- CWD and interactive detection (batched lsof calls) ---

function getPidCwds(pids: number[]): Map<number, string> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  try {
    const output = execSync(
      `lsof -a -d cwd -p ${pids.join(",")} 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    );
    for (const line of output.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const pid = parseInt(parts[1]!, 10);
      if (isNaN(pid) || !pids.includes(pid)) continue;
      const name = parts.slice(8).join(" ");
      if (name.startsWith("/")) {
        result.set(pid, name);
      }
    }
  } catch {}

  return result;
}

function getInteractiveStatus(pids: number[]): Map<number, boolean> {
  const result = new Map<number, boolean>();
  if (pids.length === 0) return result;

  if (platform() !== "darwin" && platform() !== "linux") {
    for (const pid of pids) result.set(pid, true);
    return result;
  }

  try {
    const output = execSync(
      `lsof -a -d 0 -p ${pids.join(",")} 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    );
    // Parse: each line with a pid tells us about fd 0
    for (const line of output.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = parseInt(parts[1]!, 10);
      if (isNaN(pid) || !pids.includes(pid)) continue;
      const isTty = /\/dev\/ttys/.test(line) || /\/dev\/pts\//.test(line);
      result.set(pid, isTty);
    }
  } catch {}

  // Default: interactive for anything we couldn't check
  for (const pid of pids) {
    if (!result.has(pid)) result.set(pid, true);
  }

  return result;
}

/**
 * Kill a pi process by PID.
 */
export function killProcess(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a process is still alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
