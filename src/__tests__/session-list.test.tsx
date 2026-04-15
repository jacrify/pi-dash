import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import React from "react";
import { SessionList } from "../tui/session-list.js";
import type { TrackedSession } from "../types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpDir = mkdtempSync(join(tmpdir(), "session-list-test-"));
let fileCounter = 0;

function makeSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  const filePath = join(tmpDir, `session-${fileCounter++}.jsonl`);
  writeFileSync(filePath, '{"type":"session"}\n');
  return {
    sessionId: `id-${fileCounter}`,
    shortId: `${fileCounter}`.padStart(4, "0"),
    sessionFile: filePath,
    cwd: "/Users/john/code/test",
    name: null,
    prompt: "test prompt",
    lastUserMessage: null,
    status: "done",
    pid: null,
    startedAt: new Date(),
    endedAt: null,
    duration: null,
    lastFileSize: 0,
    fileGrowingSince: null,
    turnCount: 0,
    userMessageCount: 0,
    lastToolName: null,
    lastToolArgs: null,
    lastToolCallStartedAt: null,
    lastSubagentArgs: null,
    lastAssistantStopReason: null,
    model: null,
    provider: null,
    stopReason: null,
    errorMessage: null,
    lastOutput: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 },
    isSubagent: false,
    parentPid: null,
    agentName: null,
    peekLines: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("SessionList", () => {
  it("shows empty message when no sessions", () => {
    const { lastFrame } = render(
      <SessionList sessions={[]} selectedIndex={0} />
    );
    expect(lastFrame()).toContain("No sessions found");
  });

  it("renders session rows with status icons and short IDs", () => {
    const sessions = [
      makeSession({ status: "done", shortId: "0001" }),
      makeSession({ status: "running", shortId: "0002" }),
    ];
    const { lastFrame } = render(
      <SessionList sessions={sessions} selectedIndex={0} maxHeight={10} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("✓");
    expect(frame).toContain("▶");
    expect(frame).toContain("#0001");
    expect(frame).toContain("#0002");
  });

  it("shows selection marker on selected row", () => {
    const sessions = [
      makeSession({ shortId: "0001" }),
      makeSession({ shortId: "0002" }),
    ];
    const { lastFrame } = render(
      <SessionList sessions={sessions} selectedIndex={1} maxHeight={10} />
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    // Find line with #0002 (selected) — should have '>'
    const selectedLine = lines.find((l) => l.includes("#0002"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain(">");
    // Line with #0001 should not start with '>'
    const unselectedLine = lines.find((l) => l.includes("#0001"));
    expect(unselectedLine).toBeDefined();
    expect(unselectedLine).not.toMatch(/>\s*.*#0001/);
  });

  it("shows column headers", () => {
    const sessions = [makeSession()];
    const { lastFrame } = render(
      <SessionList sessions={sessions} selectedIndex={0} maxHeight={10} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("STATUS");
    expect(frame).toContain("ID");
    expect(frame).toContain("DIRECTORY");
    expect(frame).toContain("TASK");
  });

  it("shows scroll indicators when content exceeds maxHeight", () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession({ shortId: `${i}`.padStart(4, "0") })
    );
    const { lastFrame } = render(
      <SessionList sessions={sessions} selectedIndex={0} maxHeight={5} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("↓");
  });
});
