import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processEntry, parseTail, parseSessionFile } from "../session-parser.js";
import { isAlive, MAX_PEEK_LINES } from "../types.js";
import type { TrackedSession, SessionEntry } from "../types.js";

function makeSession(overrides?: Partial<TrackedSession>): TrackedSession {
  return {
    sessionId: "test-1234",
    shortId: "test",
    sessionFile: "/tmp/test.jsonl",
    cwd: "/tmp",
    name: null,
    prompt: "",
    lastUserMessage: null,
    status: "unknown",
    pid: null,
    startedAt: new Date("2026-01-01T00:00:00Z"),
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

describe("processEntry — user message", () => {
  it("sets prompt on first user message", () => {
    const session = makeSession();
    const entry: SessionEntry = {
      type: "message",
      message: { role: "user", content: "Hello world" },
    };
    processEntry(session, entry);
    expect(session.prompt).toBe("Hello world");
    expect(session.lastUserMessage).toBe("Hello world");
    expect(session.userMessageCount).toBe(1);
  });

  it("sets lastUserMessage on subsequent user messages, keeps prompt", () => {
    const session = makeSession({ prompt: "First prompt" });
    session.userMessageCount = 1;
    const entry: SessionEntry = {
      type: "message",
      message: { role: "user", content: "Second message" },
    };
    processEntry(session, entry);
    expect(session.prompt).toBe("First prompt");
    expect(session.lastUserMessage).toBe("Second message");
    expect(session.userMessageCount).toBe(2);
  });

  it("clears lastAssistantStopReason on user message", () => {
    const session = makeSession({ lastAssistantStopReason: "stop" });
    const entry: SessionEntry = {
      type: "message",
      message: { role: "user", content: "Hi" },
    };
    processEntry(session, entry);
    expect(session.lastAssistantStopReason).toBeNull();
  });

  it("handles array content with text block", () => {
    const session = makeSession();
    const entry: SessionEntry = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Array content" }],
      },
    };
    processEntry(session, entry);
    expect(session.prompt).toBe("Array content");
    expect(session.userMessageCount).toBe(1);
  });
});

describe("processEntry — assistant message", () => {
  it("sets model, provider, accumulates usage, increments turnCount", () => {
    const session = makeSession();
    const entry: SessionEntry = {
      type: "message",
      timestamp: "2026-01-01T00:01:00Z",
      message: {
        role: "assistant",
        content: "Response text",
        provider: "anthropic",
        model: "claude-4",
        stopReason: "stop",
        usage: { input: 100, output: 50, cacheRead: 20, cost: { total: 0.01 } },
      },
    };
    processEntry(session, entry);
    expect(session.model).toBe("claude-4");
    expect(session.provider).toBe("anthropic");
    expect(session.totalUsage.inputTokens).toBe(100);
    expect(session.totalUsage.outputTokens).toBe(50);
    expect(session.totalUsage.cacheReadTokens).toBe(20);
    expect(session.totalUsage.totalCost).toBe(0.01);
    expect(session.turnCount).toBe(1);
    expect(session.lastOutput).toBe("Response text");
  });

  it("accumulates usage across multiple entries", () => {
    const session = makeSession();
    const mkEntry = (input: number, output: number): SessionEntry => ({
      type: "message",
      timestamp: "2026-01-01T00:01:00Z",
      message: {
        role: "assistant",
        content: "text",
        stopReason: "stop",
        usage: { input, output, cacheRead: 0, cost: { total: 0.005 } },
      },
    });
    processEntry(session, mkEntry(100, 50));
    processEntry(session, mkEntry(200, 80));
    expect(session.totalUsage.inputTokens).toBe(300);
    expect(session.totalUsage.outputTokens).toBe(130);
    expect(session.totalUsage.totalCost).toBeCloseTo(0.01);
    expect(session.turnCount).toBe(2);
  });

  it("captures lastToolName and lastToolArgs from content array", () => {
    const session = makeSession();
    const entry: SessionEntry = {
      type: "message",
      timestamp: "2026-01-01T00:01:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "toolCall", name: "read", arguments: { path: "/tmp/foo.ts" } },
        ],
        stopReason: "stop",
      },
    };
    processEntry(session, entry);
    expect(session.lastToolName).toBe("read");
    expect(session.lastToolArgs).toBe("/tmp/foo.ts");
    expect(session.lastOutput).toBe("Let me read that file.");
  });
});

describe("processEntry — assistant with toolUse stop", () => {
  it("sets lastToolCallStartedAt, lastToolName, lastToolArgs", () => {
    const session = makeSession();
    const entry: SessionEntry = {
      type: "message",
      timestamp: "2026-01-01T00:02:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
        ],
        stopReason: "toolUse",
      },
    };
    processEntry(session, entry);
    expect(session.lastToolName).toBe("bash");
    expect(session.lastToolArgs).toBe("ls -la");
    expect(session.lastToolCallStartedAt).toEqual(new Date("2026-01-01T00:02:00Z"));
    expect(session.lastAssistantStopReason).toBe("toolUse");
  });
});

describe("processEntry — session_info", () => {
  it("sets name", () => {
    const session = makeSession();
    const entry: SessionEntry = { type: "session_info", name: "My Session" };
    processEntry(session, entry);
    expect(session.name).toBe("My Session");
  });
});

describe("processEntry — model_change", () => {
  it("updates provider and model", () => {
    const session = makeSession({ provider: "old", model: "old-model" });
    const entry: SessionEntry = {
      type: "model_change",
      provider: "openai",
      modelId: "gpt-5",
    };
    processEntry(session, entry);
    expect(session.provider).toBe("openai");
    expect(session.model).toBe("gpt-5");
  });
});

describe("parseTail", () => {
  it("appends peekLines and processes entries", () => {
    const session = makeSession({ startedAt: new Date("2026-01-01T00:00:00Z") });
    const lines = [
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:05:00Z",
        message: { role: "user", content: "Hello from tail" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:06:00Z",
        message: {
          role: "assistant",
          content: "Reply",
          stopReason: "stop",
          usage: { input: 10, output: 5, cacheRead: 0, cost: { total: 0.001 } },
        },
      }),
    ];
    parseTail(session, lines);
    expect(session.peekLines).toHaveLength(2);
    expect(session.prompt).toBe("Hello from tail");
    expect(session.turnCount).toBe(1);
    expect(session.duration).toBe(6 * 60 * 1000); // 6 minutes
  });

  it("caps peekLines at MAX_PEEK_LINES", () => {
    const session = makeSession();
    // Pre-fill with 499 lines
    session.peekLines = Array.from({ length: 499 }, (_, i) => `line-${i}`);
    const newLines = [
      JSON.stringify({ type: "session_info", name: "A" }),
      JSON.stringify({ type: "session_info", name: "B" }),
    ];
    parseTail(session, newLines);
    expect(session.peekLines.length).toBe(MAX_PEEK_LINES);
    // oldest line should have been shifted out
    expect(session.peekLines[0]).toBe("line-1");
    expect(session.peekLines[session.peekLines.length - 1]).toContain('"name":"B"');
  });

  it("skips empty and malformed lines", () => {
    const session = makeSession();
    parseTail(session, ["", "  ", "{bad json", JSON.stringify({ type: "session_info", name: "OK" })]);
    expect(session.name).toBe("OK");
    // Only non-empty lines are added to peekLines
    expect(session.peekLines).toHaveLength(2); // "{bad json" and the valid one
  });
});

describe("parseSessionFile", () => {
  let tmpDir: string;

  function makeTmpFile(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses a complete session file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-parser-test-"));
    try {
      const lines = [
        JSON.stringify({
          type: "session",
          id: "abcd1234",
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/home/user/project",
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Fix the bug" },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T00:01:00Z",
          message: {
            role: "assistant",
            content: "Done!",
            provider: "anthropic",
            model: "claude-4",
            stopReason: "stop",
            usage: { input: 500, output: 200, cacheRead: 100, cost: { total: 0.05 } },
          },
        }),
      ];
      const filePath = makeTmpFile("session.jsonl", lines.join("\n"));
      const session = parseSessionFile(filePath);

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe("abcd1234");
      expect(session!.shortId).toBe("abcd");
      expect(session!.cwd).toBe("/home/user/project");
      expect(session!.prompt).toBe("Fix the bug");
      expect(session!.status).toBe("done");
      expect(session!.model).toBe("claude-4");
      expect(session!.provider).toBe("anthropic");
      expect(session!.turnCount).toBe(1);
      expect(session!.userMessageCount).toBe(1);
      expect(session!.totalUsage.inputTokens).toBe(500);
      expect(session!.totalUsage.outputTokens).toBe(200);
      expect(session!.totalUsage.cacheReadTokens).toBe(100);
      expect(session!.totalUsage.totalCost).toBe(0.05);
      expect(session!.lastOutput).toBe("Done!");
      expect(session!.duration).toBe(60 * 1000);
      expect(session!.peekLines).toHaveLength(2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("parseSessionFile — edge cases", () => {
  let tmpDir: string;

  function makeTmpFile(name: string, content: string): string {
    const p = join(tmpDir, name);
    writeFileSync(p, content, "utf-8");
    return p;
  }

  it("returns null for empty file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-parser-edge-"));
    try {
      const filePath = makeTmpFile("empty.jsonl", "");
      expect(parseSessionFile(filePath)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for non-session header", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-parser-edge-"));
    try {
      const filePath = makeTmpFile("bad-header.jsonl", JSON.stringify({ type: "message" }));
      expect(parseSessionFile(filePath)).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for non-existent file", () => {
    expect(parseSessionFile("/tmp/nonexistent-session-file-xyz.jsonl")).toBeNull();
  });

  it("skips malformed JSON lines gracefully", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-parser-edge-"));
    try {
      const lines = [
        JSON.stringify({ type: "session", id: "xyz", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" }),
        "{not valid json!!",
        JSON.stringify({ type: "message", message: { role: "user", content: "Hi" } }),
      ];
      const filePath = makeTmpFile("malformed.jsonl", lines.join("\n"));
      const session = parseSessionFile(filePath);
      expect(session).not.toBeNull();
      expect(session!.prompt).toBe("Hi");
      expect(session!.userMessageCount).toBe(1);
      // malformed line still ends up in peekLines
      expect(session!.peekLines).toHaveLength(2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("isAlive", () => {
  it("returns true for live statuses", () => {
    expect(isAlive("interactive-idle")).toBe(true);
    expect(isAlive("interactive-active")).toBe(true);
    expect(isAlive("running")).toBe(true);
  });

  it("returns false for terminal statuses", () => {
    expect(isAlive("done")).toBe(false);
    expect(isAlive("failed")).toBe(false);
    expect(isAlive("killed")).toBe(false);
    expect(isAlive("unknown")).toBe(false);
  });
});

describe("parseSessionFile — subagent fields", () => {
  let tmpDir: string;

  function makeTmpFile(name: string, content: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "session-parser-sub-"));
    const p = join(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  it("initializes isSubagent=false and parentPid=null for normal sessions", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "abc", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
    ];
    const filePath = makeTmpFile("normal.jsonl", lines.join("\n"));
    try {
      const session = parseSessionFile(filePath);
      expect(session).not.toBeNull();
      expect(session!.isSubagent).toBe(false);
      expect(session!.parentPid).toBeNull();
      expect(session!.agentName).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
