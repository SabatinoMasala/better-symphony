import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { useOrchestrator } from "./useOrchestrator.js";
import { Sidebar } from "./Sidebar.js";
import { LogView } from "./LogView.js";

type FocusPanel = "sidebar" | "logs";

interface AppProps {
  workflowPaths: string[];
  logFile?: string;
  debug?: boolean;
}

export function App({ workflowPaths, logFile, debug }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const shutdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focus, setFocus] = useState<FocusPanel>("logs");

  const {
    state,
    selectTab,
    prevTab,
    nextTab,
    scrollUp,
    scrollDown,
    scrollToBottom,
    shutdown,
    forcePoll,
  } = useOrchestrator(workflowPaths, logFile, debug);

  // Exit once shutdown completes
  useEffect(() => {
    if (state.shuttingDown && state.snapshot && state.snapshot.running.length === 0) {
      if (shutdownTimerRef.current) {
        clearTimeout(shutdownTimerRef.current);
        shutdownTimerRef.current = null;
      }
      exit();
    }
  }, [state.shuttingDown, state.snapshot]);

  useInput((input, key) => {
    // Quit
    if (input === "q" || key.escape) {
      if (state.shuttingDown) {
        exit();
        return;
      }
      shutdown();
      shutdownTimerRef.current = setTimeout(() => exit(), 3000);
      return;
    }

    // Panel focus switching
    if (key.leftArrow) {
      setFocus("sidebar");
      return;
    }
    if (key.rightArrow) {
      setFocus("logs");
      return;
    }

    // Up/down behavior depends on focused panel
    if (input === "j" || key.downArrow) {
      if (focus === "sidebar") {
        nextTab();
      } else {
        scrollDown(1);
      }
      return;
    }
    if (input === "k" || key.upArrow) {
      if (focus === "sidebar") {
        prevTab();
      } else {
        scrollUp(1);
      }
      return;
    }

    if (input === "G") {
      scrollToBottom();
      return;
    }

    if (input === "r") {
      forcePoll();
      return;
    }

    // Page scroll (always logs)
    if (key.pageDown) {
      scrollDown(10);
      return;
    }
    if (key.pageUp) {
      scrollUp(10);
      return;
    }

    // Number keys for tab jumping
    const num = parseInt(input, 10);
    if (num >= 1 && num <= 9) {
      selectTab(num - 1);
    }
  });

  if (state.error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Error: {state.error}
        </Text>
      </Box>
    );
  }

  const currentTab = state.tabs[state.selectedTab] ?? "all";
  const showSource = currentTab === "all";
  const lines = state.logBuffers.get(currentTab) ?? [];
  const scrollOffset = state.scrollOffsets.get(currentTab) ?? 0;
  const autoFollow = state.autoFollow.get(currentTab) ?? true;

  const termHeight = stdout?.rows ?? 24;

  return (
    <Box flexDirection="row" height={termHeight}>
      <Sidebar
        tabs={state.tabs}
        selectedTab={state.selectedTab}
        snapshot={state.snapshot}
        shuttingDown={state.shuttingDown}
        height={termHeight}
        focused={focus === "sidebar"}
      />

      <LogView
        lines={lines}
        scrollOffset={scrollOffset}
        autoFollow={autoFollow}
        height={termHeight}
        showSource={showSource}
      />
    </Box>
  );
}
