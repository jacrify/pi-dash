// Main TUI app — top-level layout and state management

import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { SessionTracker } from "../session-tracker.js";
import { killProcess } from "../process-manager.js";
import { SessionList } from "./session-list.js";
import { DetailPane } from "./detail-pane.js";
import { PeekView } from "./peek-view.js";
import { HelpOverlay } from "./help-overlay.js";
import { HeaderBar } from "./header-bar.js";
import type { TrackedSession, FilterMode, SortMode, AppState } from "../types.js";

interface AppProps {
  tracker: SessionTracker;
}

const SORT_MODES: SortMode[] = ["newest", "status", "cwd", "cost"];
const FILTER_MODES: FilterMode[] = ["all", "interactive", "running", "finished"];

/**
 * Given a new session list and a previously selected session ID,
 * find the index of that session in the new list. Falls back to
 * clamping the old numeric index.
 */
function resolveSelectedIndex(
  sessions: TrackedSession[],
  selectedSessionId: string | null,
  prevIndex: number
): number {
  if (sessions.length === 0) return 0;
  if (selectedSessionId) {
    const idx = sessions.findIndex((s) => s.sessionId === selectedSessionId);
    if (idx !== -1) return idx;
  }
  return Math.min(prevIndex, sessions.length - 1);
}

export function App({ tracker }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>({
    sessions: [],
    selectedIndex: 0,
    selectedSessionId: null,
    filter: "all",
    sort: "newest",
    searchQuery: "",
    view: "list",
    peekScrollOffset: 0,
    peekAutoScroll: true,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = () => {
    const { filter, sort, searchQuery, selectedSessionId, selectedIndex } = stateRef.current;
    const sessions = tracker.getFilteredSessions(filter, sort, searchQuery);
    const newIndex = resolveSelectedIndex(sessions, selectedSessionId, selectedIndex);
    setState((prev) => ({
      ...prev,
      sessions,
      selectedIndex: newIndex,
      // Keep the same selectedSessionId — it stays until the user moves
    }));
  };

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    tracker.start(() => refreshRef.current());
    refreshRef.current();
    return () => tracker.stop();
  }, [tracker]);

  useEffect(() => {
    refresh();
  }, [state.filter, state.sort, state.searchQuery]);

  const selected: TrackedSession | null = state.sessions[state.selectedIndex] ?? null;

  /** Move selection and update both index and sessionId */
  const moveTo = (newIndex: number) => {
    setState((prev) => {
      const clamped = Math.max(0, Math.min(prev.sessions.length - 1, newIndex));
      const session = prev.sessions[clamped];
      return {
        ...prev,
        selectedIndex: clamped,
        selectedSessionId: session?.sessionId ?? prev.selectedSessionId,
      };
    });
  };

  useInput((input, key) => {
    if (input === "q" || (key.escape && state.view === "list")) {
      if (state.view === "list") {
        exit();
        return;
      }
      setState((prev) => ({ ...prev, view: "list" }));
      return;
    }

    if (key.escape) {
      setState((prev) => ({ ...prev, view: "list" }));
      return;
    }

    if (input === "?") {
      setState((prev) => ({ ...prev, view: prev.view === "help" ? "list" : "help" }));
      return;
    }

    if (state.view === "help") return;

    if (state.view === "peek") {
      if (input === "q" || key.escape) {
        setState((prev) => ({ ...prev, view: "list" }));
      } else if (key.upArrow || input === "k") {
        setState((prev) => ({ ...prev, peekScrollOffset: Math.max(0, prev.peekScrollOffset - 1), peekAutoScroll: false }));
      } else if (key.downArrow || input === "j") {
        setState((prev) => ({ ...prev, peekScrollOffset: prev.peekScrollOffset + 1, peekAutoScroll: false }));
      } else if (input === "G") {
        setState((prev) => ({ ...prev, peekAutoScroll: true }));
      } else if (input === "F") {
        setState((prev) => ({ ...prev, peekAutoScroll: !prev.peekAutoScroll }));
      } else if (input === "K" && selected?.pid) {
        killProcess(selected.pid, "SIGTERM");
      }
      return;
    }

    // List mode
    if (key.upArrow || input === "k") {
      moveTo(state.selectedIndex - 1);
    } else if (key.downArrow || input === "j") {
      moveTo(state.selectedIndex + 1);
    } else if (key.return || input === "p") {
      if (selected) {
        setState((prev) => ({ ...prev, view: "peek", peekScrollOffset: 0, peekAutoScroll: true }));
      }
    } else if (input === "K" && selected?.pid) {
      killProcess(selected.pid, "SIGTERM");
    } else if (input === "!" && selected?.pid) {
      killProcess(selected.pid, "SIGKILL");
    } else if (input === "f") {
      setState((prev) => {
        const idx = FILTER_MODES.indexOf(prev.filter);
        return { ...prev, filter: FILTER_MODES[(idx + 1) % FILTER_MODES.length]! };
      });
    } else if (input === "s") {
      setState((prev) => {
        const idx = SORT_MODES.indexOf(prev.sort);
        return { ...prev, sort: SORT_MODES[(idx + 1) % SORT_MODES.length]! };
      });
    } else if (input === "r") {
      tracker.refresh();
    }
  });

  if (state.view === "help") {
    return <HelpOverlay />;
  }

  if (state.view === "peek" && selected) {
    return <PeekView session={selected} scrollOffset={state.peekScrollOffset} autoScroll={state.peekAutoScroll} />;
  }

  // Calculate exact line budget — every line is accounted for
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const headerLines = 1;
  const detailLines = selected ? 9 : 0; // 2 borders + 7 content lines
  const listLines = Math.max(3, termRows - headerLines - detailLines);

  return (
    <Box flexDirection="column" width="100%">
      <HeaderBar sessions={state.sessions} filter={state.filter} sort={state.sort} />
      <SessionList sessions={state.sessions} selectedIndex={state.selectedIndex} maxHeight={listLines} />
      {selected && (
        <DetailPane session={selected} height={detailLines} />
      )}
    </Box>
  );
}
