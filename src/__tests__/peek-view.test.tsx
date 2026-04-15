import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "ink-testing-library";
import React from "react";
import { PeekView } from "../tui/peek-view.js";
import type { TrackedSession } from "../types.js";

afterEach(() => {
  cleanup();
});

function makeSession(peekLines: string[] = []): TrackedSession {
  return {
    sessionId: "test-id",
    shortId: "abcd",
    sessionFile: "/tmp/test.jsonl",
    cwd: "/tmp",
    name: null,
    prompt: "test",
    lastUserMessage: null,
    status: "running",
    pid: 1234,
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
    peekLines,
  };
}

function makePeekLine(role: string, text: string, timestamp?: string): string {
  const ts = timestamp ?? new Date().toISOString();
  if (role === "user") {
    return JSON.stringify({ type: "message", timestamp: ts, message: { role: "user", content: text } });
  }
  if (role === "assistant") {
    return JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
  }
  return JSON.stringify({ type: role, timestamp: ts });
}

const delay = () => new Promise(r => setTimeout(r, 50));

describe("PeekView", () => {
  it("renders header with session info", () => {
    const { lastFrame } = render(<PeekView session={makeSession()} onExit={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain("#abcd");
    expect(frame).toContain("running");
  });

  it("renders peek lines", () => {
    const lines = [
      makePeekLine("user", "Hello world"),
      makePeekLine("user", "Second message"),
      makePeekLine("assistant", "I can help"),
    ];
    const { lastFrame } = render(<PeekView session={makeSession(lines)} onExit={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Hello world");
    expect(frame).toContain("Second message");
    expect(frame).toContain("I can help");
  });

  it("shows footer keybindings", () => {
    const { lastFrame } = render(<PeekView session={makeSession()} onExit={() => {}} onKill={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain("[q] back");
    expect(frame).toContain("[K] kill");
  });

  it("q key calls onExit", async () => {
    const onExit = vi.fn();
    const { stdin } = render(<PeekView session={makeSession()} onExit={onExit} />);
    stdin.write("q");
    await delay();
    expect(onExit).toHaveBeenCalled();
  });

  it("K key calls onKill", async () => {
    const onKill = vi.fn();
    const { stdin } = render(<PeekView session={makeSession()} onExit={() => {}} onKill={onKill} />);
    stdin.write("K");
    await delay();
    expect(onKill).toHaveBeenCalled();
  });

  it("shows tail indicator", () => {
    const { lastFrame } = render(<PeekView session={makeSession()} onExit={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain("tail");
  });

  it("empty peek lines shows no entries", () => {
    const { lastFrame } = render(<PeekView session={makeSession([])} onExit={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain("No entries");
  });
});
