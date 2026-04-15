// Main TUI app — top-level layout and state management

import React, { useState, useEffect, useRef, useCallback } from "react";
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
  onResume?: (sessionFile: string) => void;
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

export function App({ tracker, onResume }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>({
    sessions: [],
    selectedIndex: 0,
    selectedSessionId: null,
    filter: "all",
    sort: "newest",
    searchQuery: "",
    searchMode: false,
    searchMatchFiles: null,
    pathFilter: null,
    view: "list",
  });

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = () => {
    const { filter, sort, searchQuery, selectedSessionId, selectedIndex, searchMatchFiles, pathFilter } = stateRef.current;
    let sessions = tracker.getFilteredSessions(filter, sort, searchQuery);

    // Apply grep search results
    if (searchMatchFiles !== null && searchMatchFiles.size > 0) {
      sessions = sessions.filter((s) => searchMatchFiles.has(s.sessionFile));
    } else if (searchMatchFiles !== null && stateRef.current.searchQuery) {
      // Active search with no matches
      sessions = [];
    }

    // Apply path filter
    if (pathFilter) {
      sessions = sessions.filter((s) => s.cwd === pathFilter);
    }

    const newIndex = resolveSelectedIndex(sessions, selectedSessionId, selectedIndex);
    const newSelectedId = sessions[newIndex]?.sessionId ?? selectedSessionId;
    setState((prev) => ({
      ...prev,
      sessions,
      selectedIndex: newIndex,
      selectedSessionId: newSelectedId,
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
  }, [state.filter, state.sort, state.searchQuery, state.searchMatchFiles, state.pathFilter]);

  const triggerSearch = useCallback((query: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query) {
      setState((prev) => ({ ...prev, searchMatchFiles: null }));
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      tracker.searchFiles(query, (matchingFiles) => {
        setState((prev) => {
          // Only apply if query hasn't changed since we started
          if (prev.searchQuery !== query) return prev;
          return { ...prev, searchMatchFiles: matchingFiles };
        });
      });
    }, 150);
  }, [tracker]);

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
    // --- Search mode input handling ---
    if (state.searchMode) {
      if (key.escape) {
        // Exit search, clear query
        setState((prev) => ({
          ...prev,
          searchMode: false,
          searchQuery: "",
          searchMatchFiles: null,
        }));
        return;
      }
      if (key.return) {
        // Confirm search, exit search mode but keep filter
        setState((prev) => ({ ...prev, searchMode: false }));
        return;
      }
      if (key.backspace || key.delete) {
        setState((prev) => {
          const q = prev.searchQuery.slice(0, -1);
          triggerSearch(q);
          return { ...prev, searchQuery: q };
        });
        return;
      }
      // Navigation still works during search
      if (key.upArrow) {
        moveTo(state.selectedIndex - 1);
        return;
      }
      if (key.downArrow) {
        moveTo(state.selectedIndex + 1);
        return;
      }
      // Printable character → append to query
      if (input && !key.ctrl && !key.meta) {
        setState((prev) => {
          const q = prev.searchQuery + input;
          triggerSearch(q);
          return { ...prev, searchQuery: q };
        });
      }
      return;
    }

    // --- Normal mode ---
    if (key.escape) {
      if (state.searchQuery) {
        // Clear active search filter
        setState((prev) => ({ ...prev, searchQuery: "", searchMatchFiles: null }));
        return;
      }
      if (state.view !== "list") {
        setState((prev) => ({ ...prev, view: "list" }));
        return;
      }
      return;
    }

    if (input === "q" && state.view === "list") {
      exit();
      return;
    }

    if (input === "?") {
      setState((prev) => ({ ...prev, view: prev.view === "help" ? "list" : "help" }));
      return;
    }

    if (state.view === "help") return;

    if (state.view === "peek") return; // PeekView handles its own input

    // List mode
    if (input === "/") {
      setState((prev) => ({ ...prev, searchMode: true, searchQuery: "", searchMatchFiles: null }));
    } else if (key.upArrow || input === "k") {
      moveTo(state.selectedIndex - 1);
    } else if (key.downArrow || input === "j") {
      moveTo(state.selectedIndex + 1);
    } else if (key.return || input === "p") {
      if (selected) {
        setState((prev) => ({ ...prev, view: "peek" }));
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
    } else if (input === "R" && selected && onResume && !selected.pid) {
      onResume(selected.sessionFile);
    } else if (input === "d") {
      setState((prev) => {
        const sel = prev.sessions[prev.selectedIndex];
        if (!sel) return prev;
        const newFilter = prev.pathFilter === sel.cwd ? null : sel.cwd;
        return { ...prev, pathFilter: newFilter };
      });
    } else if (input === "r") {
      tracker.refresh();
    }
  });

  if (state.view === "help") {
    return <HelpOverlay />;
  }

  if (state.view === "peek" && selected) {
    return <PeekView session={selected} onExit={() => setState((prev) => ({ ...prev, view: "list" }))} onKill={selected.pid ? () => killProcess(selected.pid!, "SIGTERM") : undefined} />;
  }

  // Calculate exact line budget — every line is accounted for
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const headerLines = 1;
  const detailLines = selected ? 9 : 0; // 2 borders + 7 content lines
  const listLines = Math.max(3, termRows - headerLines - detailLines);

  return (
    <Box flexDirection="column" width="100%">
      <HeaderBar sessions={state.sessions} filter={state.filter} sort={state.sort} searchMode={state.searchMode} searchQuery={state.searchQuery} pathFilter={state.pathFilter} />
      <SessionList sessions={state.sessions} selectedIndex={state.selectedIndex} maxHeight={listLines} />
      {selected && (
        <DetailPane session={selected} height={detailLines} />
      )}
    </Box>
  );
}
