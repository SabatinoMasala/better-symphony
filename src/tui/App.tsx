import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { CliRenderer } from "@opentui/core";
import { useEffect, useRef } from "react";
import { useOrchestrator } from "./useOrchestrator.js";
import { TabBar } from "./TabBar.js";
import { LogView } from "./LogView.js";
import { StatusBar } from "./StatusBar.js";

interface AppProps {
  workflowPaths: string[];
  logFile?: string;
  debug?: boolean;
  renderer: CliRenderer;
}

export function App({ workflowPaths, logFile, debug, renderer }: AppProps) {
  const shutdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { height } = useTerminalDimensions();

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
      renderer.destroy();
    }
  }, [state.shuttingDown, state.snapshot]);

  useKeyboard((key) => {
    // Quit
    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (state.shuttingDown) {
        renderer.destroy();
        return;
      }
      shutdown();
      shutdownTimerRef.current = setTimeout(() => renderer.destroy(), 3000);
      return;
    }

    // Tab switching with [ and ]
    if (key.name === "[") {
      prevTab();
      return;
    }
    if (key.name === "]") {
      nextTab();
      return;
    }

    // Tab switching with left/right arrows
    if (key.name === "left") {
      prevTab();
      return;
    }
    if (key.name === "right") {
      nextTab();
      return;
    }

    // Scrolling
    if (key.name === "j" || key.name === "down") {
      scrollDown(1);
      return;
    }
    if (key.name === "k" || key.name === "up") {
      scrollUp(1);
      return;
    }

    if (key.shift && key.name === "g") {
      scrollToBottom();
      return;
    }

    if (key.name === "r") {
      forcePoll();
      return;
    }

    // Page scroll
    if (key.name === "pagedown") {
      scrollDown(10);
      return;
    }
    if (key.name === "pageup") {
      scrollUp(10);
      return;
    }

    // Number keys for tab jumping
    const num = parseInt(key.name, 10);
    if (num >= 1 && num <= 9) {
      selectTab(num - 1);
    }
  });

  if (state.error) {
    return (
      <box flexDirection="column" padding={1} width="100%" height="100%">
        <text>
          <span fg="#FF4444"><strong>Error: {state.error}</strong></span>
        </text>
      </box>
    );
  }

  const currentTab = state.tabs[state.selectedTab] ?? "all";
  const showSource = currentTab === "all";
  const lines = state.logBuffers.get(currentTab) ?? [];
  const scrollOffset = state.scrollOffsets.get(currentTab) ?? 0;
  const autoFollow = state.autoFollow.get(currentTab) ?? true;

  // TabBar: border(2) + content(1) = 3 rows
  // StatusBar: border(2) + content(1) = 3 rows
  // LogView border adds 2 rows on its own, so we pass inner height
  const tabBarHeight = 3;
  const statusBarHeight = 3;
  const logHeight = Math.max(1, height - tabBarHeight - statusBarHeight - 2);

  return (
    <box flexDirection="column" width="100%" height="100%">
      <TabBar
        tabs={state.tabs}
        selectedTab={state.selectedTab}
        snapshot={state.snapshot}
      />

      <LogView
        lines={lines}
        scrollOffset={scrollOffset}
        autoFollow={autoFollow}
        height={logHeight}
        showSource={showSource}
      />

      <StatusBar
        snapshot={state.snapshot}
        shuttingDown={state.shuttingDown}
      />
    </box>
  );
}
