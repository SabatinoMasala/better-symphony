import { useState, useCallback, useEffect } from "react";
import { useSSE } from "./lib/use-sse";
import { Header } from "./components/header";
import { StatsCards } from "./components/stats-cards";
import { AgentTable } from "./components/agent-table";
import { RetryTable } from "./components/retry-table";
import { LogStream } from "./components/log-stream";

export function App() {
  const { snapshot, logs, connected, startTime, actions } = useSSE();
  const [sourceFilter, setSourceFilter] = useState("all");
  const [polling, setPolling] = useState(false);

  const handleAgentClick = useCallback((issueIdentifier: string) => {
    setSourceFilter(issueIdentifier);
  }, []);

  const handleForcePoll = useCallback(async () => {
    setPolling(true);
    try { await actions.forcePoll(); } finally { setPolling(false); }
  }, [actions.forcePoll]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "r") handleForcePoll();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleForcePoll]);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-x-hidden">
      <Header
        connected={connected}
        startTime={startTime}
        polling={polling}
        onForcePoll={handleForcePoll}
        onRestart={actions.restart}
        onShutdown={actions.shutdown}
      />

      <main className="flex flex-col flex-1 min-h-0 p-4 sm:p-6 gap-4">
        <StatsCards snapshot={snapshot} onAgentClick={handleAgentClick} />

        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-2">Running Agents</h2>
            <AgentTable running={snapshot?.running ?? []} onAgentClick={handleAgentClick} />
          </div>

          <RetryTable retrying={snapshot?.retrying ?? []} />
        </div>

        <LogStream logs={logs} sourceFilter={sourceFilter} onSourceFilterChange={setSourceFilter} />
      </main>
    </div>
  );
}
