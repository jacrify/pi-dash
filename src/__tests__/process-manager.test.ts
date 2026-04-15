import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isProcessAlive, matchProcessesToSessions } from "../process-manager.js";

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a bogus PID", () => {
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe("matchProcessesToSessions", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), "pm-test-"));
    tmpDirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  it("matches a process to a session file via mtime fallback", () => {
    const sessionDir = makeTmpDir();
    const encoded = "--Users-john-code-foo--";
    const cwdDir = join(sessionDir, encoded);
    mkdirSync(cwdDir, { recursive: true });

    const filename = "2026-04-14T20-47-23-836Z_someuuid.jsonl";
    const filePath = join(cwdDir, filename);
    writeFileSync(filePath, JSON.stringify({ type: "session", id: "someuuid" }) + "\n");

    // Touch the file to make mtime within last 30s
    const now = new Date();
    utimesSync(filePath, now, now);

    const processes = [{ pid: 99998, cwd: "/Users/john/code/foo" }];
    const matches = matchProcessesToSessions(processes, sessionDir);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.pid).toBe(99998);
    expect(matches[0]!.sessionFile).toBe(filePath);
  });

  it("does not match a process with wrong cwd", () => {
    const sessionDir = makeTmpDir();
    const encoded = "--Users-john-code-foo--";
    const cwdDir = join(sessionDir, encoded);
    mkdirSync(cwdDir, { recursive: true });

    const filename = "2026-04-14T20-47-23-836Z_someuuid.jsonl";
    const filePath = join(cwdDir, filename);
    writeFileSync(filePath, JSON.stringify({ type: "session", id: "someuuid" }) + "\n");
    const now = new Date();
    utimesSync(filePath, now, now);

    const processes = [{ pid: 99998, cwd: "/Users/john/code/bar" }];
    const matches = matchProcessesToSessions(processes, sessionDir);

    expect(matches).toHaveLength(0);
  });

  it("returns empty matches for an empty session dir", () => {
    const sessionDir = makeTmpDir();
    const processes = [{ pid: 99998, cwd: "/Users/john/code/foo" }];
    const matches = matchProcessesToSessions(processes, sessionDir);

    expect(matches).toHaveLength(0);
  });
});
