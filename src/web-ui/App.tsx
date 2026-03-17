import { useState, useCallback } from "react";
import { useSSE } from "./lib/use-sse";
import { Header } from "./components/header";
import { StatsCards } from "./components/stats-cards";
import { AgentTable } from "./components/agent-table";
import { RetryTable } from "./components/retry-table";
import { LogStream } from "./components/log-stream";

export function App() {
  const { snapshot, logs, connected, startTime, actions } = useSSE();
  const [sourceFilter, setSourceFilter] = useState("all");

  const handleAgentClick = useCallback((issueIdentifier: string) => {
    setSourceFilter(issueIdentifier);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-x-hidden">
      <Header
        connected={connected}
        startTime={startTime}
        onForcePoll={actions.forcePoll}
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
