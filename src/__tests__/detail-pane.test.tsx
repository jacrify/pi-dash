import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import React from "react";
import { DetailPane } from "../tui/detail-pane.js";
import type { TrackedSession } from "../types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpDir = mkdtempSync(join(tmpdir(), "detail-pane-test-"));
const tmpFile = join(tmpDir, "test.jsonl");
writeFileSync(tmpFile, '{"type":"session"}\n');

function makeSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    sessionId: "test-id",
    shortId: "abcd",
    sessionFile: tmpFile,
    cwd: "/Users/john/code/myproject",
    name: null,
    prompt: "test prompt",
    lastUserMessage: null,
    status: "done",
    pid: null,
    startedAt: new Date(),
    endedAt: null,
    duration: 60000,
    lastFileSize: 0,
    fileGrowingSince: null,
    turnCount: 5,
    userMessageCount: 3,
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
    totalUsage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, totalCost: 0 },
    peekLines: [],
    isSubagent: false,
    parentPid: null,
    agentName: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("DetailPane", () => {
  it("shows session status", () => {
    const { lastFrame } = render(<DetailPane session={makeSession({ status: "done" })} height={9} />);
    expect(lastFrame()).toContain("DONE");
  });

  it("shows CWD", () => {
    const { lastFrame } = render(<DetailPane session={makeSession()} height={9} />);
    expect(lastFrame()).toContain("/Users/john/code/myproject");
  });

  it("shows model info", () => {
    const { lastFrame } = render(
      <DetailPane session={makeSession({ model: "claude-4", provider: "anthropic" })} height={9} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("claude-4");
    expect(frame).toContain("anthropic");
  });

  it("shows cost", () => {
    const { lastFrame } = render(
      <DetailPane
        session={makeSession({ totalUsage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, totalCost: 0.1234 } })}
        height={9}
      />
    );
    expect(lastFrame()).toContain("$0.1234");
  });

  it("shows prompt text", () => {
    const { lastFrame } = render(
      <DetailPane session={makeSession({ prompt: "Build a REST API" })} height={9} />
    );
    expect(lastFrame()).toContain("Build a REST API");
  });

  it("shows error", () => {
    const { lastFrame } = render(
      <DetailPane session={makeSession({ errorMessage: "Rate limit exceeded" })} height={9} />
    );
    expect(lastFrame()).toContain("Rate limit exceeded");
  });

  it("shows borders", () => {
    const { lastFrame } = render(<DetailPane session={makeSession()} height={9} />);
    expect(lastFrame()).toContain("─");
  });
});
