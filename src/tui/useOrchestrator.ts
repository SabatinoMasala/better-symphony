import { useState, useEffect, useCallback, useRef } from "react";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { MultiOrchestrator } from "../orchestrator/multi-orchestrator.js";
import { logger, createFileSink } from "../logging/logger.js";
import { createTuiSink } from "./sink.js";
import type { LogLine } from "./types.js";
import type { RuntimeSnapshot } from "../orchestrator/state.js";
import type { ExpandedWorkflow } from "../config/types.js";

interface OrchestratorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  forcePoll(): Promise<void>;
  getSnapshot(): RuntimeSnapshot | null;
  triggerCron?(workflowName: string): Promise<boolean>;
}

const MAX_BUFFER = 5000;
const TRIM_AMOUNT = 1000;
const FLUSH_INTERVAL_MS = 50;

export interface TuiState {
  tabs: string[];
  selectedTab: number;
  logBuffers: Map<string, LogLine[]>;
  scrollOffsets: Map<string, number>;
  autoFollow: Map<string, boolean>;
  snapshot: RuntimeSnapshot | null;
  nextPollSecs: number;
  shuttingDown: boolean;
  started: boolean;
  error: string | null;
}

export function useOrchestrator(workflows: ExpandedWorkflow[], logFile?: string, debug?: boolean) {
  const orchestratorRef = useRef<OrchestratorLike | null>(null);
  const pendingLinesRef = useRef<LogLine[]>([]);

  const [state, setState] = useState<TuiState>({
    tabs: ["all"],
    selectedTab: 0,
    logBuffers: new Map([["all", []]]),
    scrollOffsets: new Map([["all", 0]]),
    autoFollow: new Map([["all", true]]),
    snapshot: null,
    nextPollSecs: 0,
    shuttingDown: false,
    started: false,
    error: null,
  });

  // Flush pending lines into state on an interval
  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingLinesRef.current.length === 0) return;

      const toFlush = [...pendingLinesRef.current];
      pendingLinesRef.current = [];

      setState((prev) => {
        const newBuffers = new Map(prev.logBuffers);

        for (const line of toFlush) {
          // Add to specific source tab buffer
          if (line.source !== "orchestrator") {
            if (!newBuffers.has(line.source)) {
              newBuffers.set(line.source, []);
            }
            const tabBuffer = newBuffers.get(line.source)!;
            tabBuffer.push(line);
            if (tabBuffer.length > MAX_BUFFER) {
              newBuffers.set(line.source, tabBuffer.slice(TRIM_AMOUNT));
            }
          }

          // Always add to "all" tab
          const allBuffer = newBuffers.get("all") ?? [];
          allBuffer.push(line);
          if (allBuffer.length > MAX_BUFFER) {
            newBuffers.set("all", allBuffer.slice(TRIM_AMOUNT));
          } else {
            newBuffers.set("all", allBuffer);
          }
        }

        // Derive tabs from buffers
        const agentTabs = Array.from(newBuffers.keys()).filter((k) => k !== "all");
        const newTabs = ["all", ...agentTabs];

        let selectedTab = prev.selectedTab;
        if (selectedTab >= newTabs.length) {
          selectedTab = 0;
        }

        return { ...prev, logBuffers: newBuffers, tabs: newTabs, selectedTab };
      });
    }, FLUSH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  // Snapshot refresh
  useEffect(() => {
    const timer = setInterval(() => {
      const orch = orchestratorRef.current;
      if (!orch) return;

      setState((prev) => ({
        ...prev,
        snapshot: orch.getSnapshot(),
      }));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Initialize orchestrator
  useEffect(() => {
    // Add TUI sink
    const tuiSink = createTuiSink((line: LogLine) => {
      pendingLinesRef.current.push(line);
    });
    logger.addSink(tuiSink);

    // TUI always shows all log levels
    logger.setMinLevel("debug");

    // Add file sink if requested
    if (logFile) {
      logger.addSink(createFileSink(logFile));
    }

    const orch: OrchestratorLike = workflows.length > 1
      ? new MultiOrchestrator({ workflows, debug })
      : new Orchestrator({ workflowPath: workflows[0].path, profileName: workflows[0].profileName, debug });
    orchestratorRef.current = orch;

    orch
      .start()
      .then(() => {
        setState((prev) => ({ ...prev, started: true }));
      })
      .catch((e: any) => {
        setState((prev) => ({
          ...prev,
          error: e.message,
          started: false,
        }));
      });

    return () => {
      orch.stop();
    };
  }, []);

  // Actions
  const selectTab = useCallback((index: number) => {
    setState((prev) => {
      if (index < 0 || index >= prev.tabs.length) return prev;
      return { ...prev, selectedTab: index };
    });
  }, []);

  const prevTab = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selectedTab: Math.max(0, prev.selectedTab - 1),
    }));
  }, []);

  const nextTab = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selectedTab: Math.min(prev.tabs.length - 1, prev.selectedTab + 1),
    }));
  }, []);

  const scrollUp = useCallback((amount = 1) => {
    setState((prev) => {
      const tab = prev.tabs[prev.selectedTab] ?? "all";
      const buffer = prev.logBuffers.get(tab) ?? [];
      const maxOffset = Math.max(0, buffer.length - 20);
      const current = prev.scrollOffsets.get(tab) ?? 0;
      const newOffset = Math.min(maxOffset, current + amount);

      const newScrolls = new Map(prev.scrollOffsets);
      newScrolls.set(tab, newOffset);

      const newFollow = new Map(prev.autoFollow);
      newFollow.set(tab, false);

      return { ...prev, scrollOffsets: newScrolls, autoFollow: newFollow };
    });
  }, []);

  const scrollDown = useCallback((amount = 1) => {
    setState((prev) => {
      const tab = prev.tabs[prev.selectedTab] ?? "all";
      const current = prev.scrollOffsets.get(tab) ?? 0;
      const newOffset = Math.max(0, current - amount);

      const newScrolls = new Map(prev.scrollOffsets);
      newScrolls.set(tab, newOffset);

      const newFollow = new Map(prev.autoFollow);
      newFollow.set(tab, newOffset === 0);

      return { ...prev, scrollOffsets: newScrolls, autoFollow: newFollow };
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    setState((prev) => {
      const tab = prev.tabs[prev.selectedTab] ?? "all";

      const newScrolls = new Map(prev.scrollOffsets);
      newScrolls.set(tab, 0);

      const newFollow = new Map(prev.autoFollow);
      newFollow.set(tab, true);

      return { ...prev, scrollOffsets: newScrolls, autoFollow: newFollow };
    });
  }, []);

  const shutdown = useCallback(() => {
    setState((prev) => ({ ...prev, shuttingDown: true }));
    orchestratorRef.current?.stop();
  }, []);

  const forcePoll = useCallback(() => {
    orchestratorRef.current?.forcePoll();
  }, []);

  return {
    state,
    selectTab,
    prevTab,
    nextTab,
    scrollUp,
    scrollDown,
    scrollToBottom,
    shutdown,
    forcePoll,
  };
}
