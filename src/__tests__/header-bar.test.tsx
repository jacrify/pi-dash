import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import React from "react";
import { HeaderBar } from "../tui/header-bar.js";
import type { TrackedSession } from "../types.js";

function makeSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    sessionId: "test-id",
    shortId: "test",
    sessionFile: "/tmp/test.jsonl",
    cwd: "/tmp",
    name: null,
    prompt: "test",
    lastUserMessage: null,
    status: "unknown",
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

describe("HeaderBar", () => {
  it("shows session counts", () => {
    const sessions = [
      makeSession({ sessionId: "1", status: "running" }),
      makeSession({ sessionId: "2", status: "running" }),
      makeSession({ sessionId: "3", status: "interactive-idle" }),
      makeSession({ sessionId: "4", status: "done" }),
      makeSession({ sessionId: "5", status: "failed" }),
    ];
    const { lastFrame, unmount } = render(
      <HeaderBar sessions={sessions} filter="all" sort="newest" searchMode={false} searchQuery="" pathFilter={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("2 running");
    expect(frame).toContain("1 interactive");
    expect(frame).toContain("1 done");
    expect(frame).toContain("1 failed");
    unmount();
  });

  it("shows filter and sort", () => {
    const { lastFrame, unmount } = render(
      <HeaderBar sessions={[]} filter="running" sort="cost" searchMode={false} searchQuery="" pathFilter={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("running");
    expect(frame).toContain("cost");
    unmount();
  });

  it("shows search mode with query", () => {
    const { lastFrame, unmount } = render(
      <HeaderBar sessions={[]} filter="all" sort="newest" searchMode={true} searchQuery="hello" pathFilter={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("hello");
    unmount();
  });

  it("shows path filter", () => {
    const { lastFrame, unmount } = render(
      <HeaderBar sessions={[]} filter="all" sort="newest" searchMode={false} searchQuery="" pathFilter="/Users/john/code/foo" />
    );
    const frame = lastFrame()!;
    // shortenPath replaces $HOME with ~; ink may wrap text across lines
    // so check that the path content appears somewhere in the output
    // ink wraps at narrow terminal width, so just check the path prefix appears
    expect(frame).toContain("~/code/fo");
    unmount();
  });

  it("shows zero counts for empty sessions", () => {
    const { lastFrame, unmount } = render(
      <HeaderBar sessions={[]} filter="all" sort="newest" searchMode={false} searchQuery="" pathFilter={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("0 running");
    expect(frame).toContain("0 done");
    unmount();
  });
});
