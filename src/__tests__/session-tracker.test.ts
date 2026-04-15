import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionTracker } from "../session-tracker.js";
import { parseChildProcessPs } from "../session-tracker.js";
import type { TrackedSession } from "../types.js";

// --- Helpers ---

function encodeCwd(cwd: string): string {
  // Remove leading `/`, replace remaining `/` with `-`, wrap in `--`
  return `--${cwd.slice(1).replace(/\//g, "-")}--`;
}

function formatTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}-${pad3(d.getUTCMilliseconds())}Z`;
}

interface SessionEntryLine {
  [key: string]: any;
}

function writeSession(
  sessionDir: string,
  cwd: string,
  sessionId: string,
  entries: SessionEntryLine[],
  timestamp?: Date,
): string {
  const ts = timestamp ?? new Date();
  const dirName = encodeCwd(cwd);
  const dirPath = join(sessionDir, dirName);
  mkdirSync(dirPath, { recursive: true });

  const header = {
    type: "session",
    id: sessionId,
    timestamp: ts.toISOString(),
    cwd,
  };

  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n";
  const fileName = `${formatTimestamp(ts)}_${sessionId}.jsonl`;
  const filePath = join(dirPath, fileName);
  writeFileSync(filePath, lines);
  return filePath;
}

function makeAssistantMessage(opts: {
  stopReason?: string;
  errorMessage?: string;
  cost?: number;
  text?: string;
}): SessionEntryLine {
  return {
    type: "message",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: opts.text ? [{ type: "text", text: opts.text }] : "ok",
      stopReason: opts.stopReason ?? "stop",
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cost: { total: opts.cost ?? 0.001 },
      },
    },
  };
}

// --- Test state ---

const tmpDirs: string[] = [];
const trackers: SessionTracker[] = [];

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "st-test-"));
  tmpDirs.push(d);
  return d;
}

function makeTracker(opts: ConstructorParameters<typeof SessionTracker>[0]): SessionTracker {
  const t = new SessionTracker(opts);
  trackers.push(t);
  return t;
}

afterEach(() => {
  for (const t of trackers) {
    t.stop();
  }
  trackers.length = 0;
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tmpDirs.length = 0;
});

// --- Tests ---

describe("SessionTracker", () => {
  describe("fullScan discovers sessions", () => {
    it("finds a session written to the proper directory structure", () => {
      const sessionDir = makeTmpDir();
      const cwd = "/Users/john/code/foo";
      writeSession(sessionDir, cwd, "abcd1234", [
        makeAssistantMessage({ stopReason: "stop", cost: 0.01 }),
      ]);

      const tracker = makeTracker({ sessionDir, pollIntervalMs: 60000 });
      tracker.start(() => {});

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.sessionId).toBe("abcd1234");
      expect(sessions[0]!.cwd).toBe(cwd);
    });

    it("discovers multiple sessions across different cwds", () => {
      const sessionDir = makeTmpDir();
      writeSession(sessionDir, "/Users/john/code/foo", "sess1", [
        makeAssistantMessage({ stopReason: "stop" }),
      ]);
      writeSession(sessionDir, "/Users/john/code/bar", "sess2", [
        makeAssistantMessage({ stopReason: "stop" }),
      ]);

      const tracker = makeTracker({ sessionDir, pollIntervalMs: 60000 });
      tracker.start(() => {});

      const sessions = tracker.getSessions();
      expect(sessions.length).toBe(2);
      const ids = sessions.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["sess1", "sess2"]);
    });
  });

  describe("getFilteredSessions — filter modes", () => {
    it("filter=finished returns done and failed sessions", () => {
      const sessionDir = makeTmpDir();

      // done: has stopReason "stop"
      writeSession(sessionDir, "/tmp/a", "done1", [
        makeAssistantMessage({ stopReason: "stop" }),
      ]);

      // failed: has stopReason "error" + errorMessage
      writeSession(sessionDir, "/tmp/a", "fail1", [
        makeAssistantMessage({ stopReason: "error", errorMessage: "boom" }),
      ]);

      // unknown: no assistant message at all → status stays "unknown"
      writeSession(sessionDir, "/tmp/a", "unk1", []);

      const tracker = makeTracker({ sessionDir, pollIntervalMs: 60000 });
      tracker.start(() => {});

      const all = tracker.getFilteredSessions("all", "newest", "");
      expect(all.length).toBe(3);

      const finished = tracker.getFilteredSessions("finished", "newest", "");
      const statuses = finished.map((s) => s.status);
      expect(statuses.every((st) => st === "done" || st === "failed" || st === "killed")).toBe(true);
      expect(finished.length).toBe(2);

      const finishedIds = finished.map((s) => s.sessionId).sort();
      expect(finishedIds).toEqual(["done1", "fail1"]);
    });

    it("filter=all returns everything", () => {
      const sessionDir = makeTmpDir();
      writeSession(sessionDir, "/tmp/a", "s1", [makeAssistantMessage({ stopReason: "stop" })]);
      writeSession(sessionDir, "/tmp/a", "s2", []);

      const tracker = makeTracker({ sessionDir, pollIntervalMs: 60000 });
      tracker.start(() => {});

      const all = tracker.getFilteredSessions("all", "newest", "");
      expect(all.length).toBe(2);
    });
  });

  describe("getFilteredSessions — sort by cost", () => {
    it("sorts highest cost first", () => {
      const sessionDir = makeTmpDir();
      writeSession(sessionDir, "/tmp/a", "cheap", [
        makeAssistantMessage({ stopReason: "stop", cost: 0.01 }),
      ]);
      writeSession(sessionDir, "/tmp/a", "expensive", [
        makeAssistantMessage({ stopReason: "stop", cost: 1.5 }),
      ]);

      const tracker = makeTracker({ sessionDir, pollIntervalMs: 60000 });
      tracker.start(() => {});

      const sorted = tracker.getFilteredSessions("all", "cost", "");
      expect(sorted.length).toBe(2);
      expect(sorted[0]!.sessionId).toBe("expensive");
      expect(sorted[1]!.sessionId).toBe("cheap");
      expect(sorted[0]!.totalUsage.totalCost).toBeGreaterThan(sorted[1]!.totalUsage.totalCost);
    });
  });

  describe("getFilteredSessions — sort by newest", () => {
    it("sorts most recent mtime first", () => {
      const sessionDir = makeTmpDir();
      const oldTime = new Date("2025-01-01T00:00:00Z");
      const newTime = new Date("2025-06-15T12:00:00Z");

      const oldFile = writeSession(sessionDir, "/tmp/a", "old1", [
        makeAssistantMessage({ stopReason: "stop" }),
      ], oldTime);
      const newFile = writeSession(sessionDir, "/tmp/a", "new1", [
        makeAssistantMessage({ stopReason: "stop" }),
      ], newTime);

      // Set mtimes explicitly
      utimesSync(oldFile, oldTime, oldTime);
      utimesSync(newFile, newTime, newTime);

      const tracker = makeTracker({ sessionDir, pollIntervalMs: 60000 });
      tracker.start(() => {});

      const sorted = tracker.getFilteredSessions("all", "newest", "");
      expect(sorted.length).toBe(2);
      expect(sorted[0]!.sessionId).toBe("new1");
      expect(sorted[1]!.sessionId).toBe("old1");
    });
  });

  describe("cwdFilter", () => {
    it("only returns sessions matching the cwdFilter", () => {
      const sessionDir = makeTmpDir();
      const cwdA = "/Users/john/code/alpha";
      const cwdB = "/Users/john/code/beta";

      writeSession(sessionDir, cwdA, "alpha1", [
        makeAssistantMessage({ stopReason: "stop" }),
      ]);
      writeSession(sessionDir, cwdB, "beta1", [
        makeAssistantMessage({ stopReason: "stop" }),
      ]);

      const tracker = makeTracker({ sessionDir, cwdFilter: cwdA, pollIntervalMs: 60000 });
      tracker.start(() => {});

      // getSessions returns all (cwdFilter is applied in getFilteredSessions)
      const allRaw = tracker.getSessions();
      expect(allRaw.length).toBe(2);

      const filtered = tracker.getFilteredSessions("all", "newest", "");
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.sessionId).toBe("alpha1");
      expect(filtered[0]!.cwd).toBe(cwdA);
    });
  });
});

describe("parseChildProcessPs", () => {
  it("parses a single child process with lstart and args", () => {
    const output = [
      "  PID STARTED",
      "17518 Wed 15 Apr 14:00:30 2026     sleep 30",
    ].join("\n");
    const result = parseChildProcessPs(output);
    expect(result).not.toBeNull();
    expect(result!.args).toBe("sleep 30");
    expect(result!.startedAt.getTime()).toBe(new Date("Wed 15 Apr 2026 14:00:30").getTime());
  });

  it("skips node and pi processes, returns the real child", () => {
    const output = [
      "  PID STARTED",
      "10001 Wed 15 Apr 14:00:30 2026     node /opt/homebrew/bin/pi --mode json",
      "10002 Wed 15 Apr 14:00:31 2026     pi",
      "10003 Wed 15 Apr 14:00:32 2026     sleep 45",
    ].join("\n");
    const result = parseChildProcessPs(output);
    expect(result).not.toBeNull();
    expect(result!.args).toBe("sleep 45");
    // Should use the child process start time, not the node/pi ones
    expect(result!.startedAt.getTime()).toBe(new Date("Wed 15 Apr 2026 14:00:32").getTime());
  });

  it("returns null when all children are node/pi", () => {
    const output = [
      "  PID STARTED",
      "10001 Wed 15 Apr 14:00:30 2026     node something",
      "10002 Wed 15 Apr 14:00:31 2026     pi",
    ].join("\n");
    const result = parseChildProcessPs(output);
    expect(result).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseChildProcessPs("")).toBeNull();
    expect(parseChildProcessPs("  PID STARTED\n")).toBeNull();
  });

  it("picks the last (most recent) non-node child when reversed", () => {
    const output = [
      "  PID STARTED",
      "10003 Wed 15 Apr 14:00:00 2026     sleep 20",
      "10004 Wed 15 Apr 14:00:25 2026     sleep 25",
    ].join("\n");
    const result = parseChildProcessPs(output);
    expect(result).not.toBeNull();
    // Reversed iteration: last line first, so sleep 25 is picked
    expect(result!.args).toBe("sleep 25");
    expect(result!.startedAt.getTime()).toBe(new Date("Wed 15 Apr 2026 14:00:25").getTime());
  });

  it("truncates long args to 80 chars", () => {
    const longCmd = "grep -r " + "x".repeat(200) + " /some/path";
    const output = [
      "  PID STARTED",
      `10003 Wed 15 Apr 14:00:00 2026     ${longCmd}`,
    ].join("\n");
    const result = parseChildProcessPs(output);
    expect(result).not.toBeNull();
    expect(result!.args.length).toBe(80);
  });

  it("handles bash -c commands", () => {
    const output = [
      "  PID STARTED",
      "10003 Wed 15 Apr 14:00:00 2026     /bin/bash -c echo hello && sleep 10",
    ].join("\n");
    const result = parseChildProcessPs(output);
    expect(result).not.toBeNull();
    expect(result!.args).toBe("/bin/bash -c echo hello && sleep 10");
  });
});
