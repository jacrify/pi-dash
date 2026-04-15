import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "ink-testing-library";
import React from "react";
import { HelpOverlay } from "../tui/help-overlay.js";

afterEach(() => {
  cleanup();
});

describe("HelpOverlay", () => {
  it("contains keybinding sections", () => {
    const { lastFrame } = render(<HelpOverlay />);
    const frame = lastFrame()!;
    expect(frame).toContain("List View");
    expect(frame).toContain("Search Mode");
    expect(frame).toContain("Peek View");
  });

  it("contains key keybindings", () => {
    const { lastFrame } = render(<HelpOverlay />);
    const frame = lastFrame()!;
    expect(frame).toContain("Enter/p");
    expect(frame).toContain("Kill");
    expect(frame).toContain("/");
    expect(frame).toContain("q");
    expect(frame).toContain("Quit");
  });

  it("contains session category descriptions", () => {
    const { lastFrame } = render(<HelpOverlay />);
    const frame = lastFrame()!;
    expect(frame).toContain("running");
    expect(frame).toContain("idle");
    expect(frame).toContain("done");
    expect(frame).toContain("failed");
  });
});
