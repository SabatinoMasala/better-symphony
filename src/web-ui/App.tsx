import { useSSE } from "./lib/use-sse";
import { Header } from "./components/header";
import { StatsCards } from "./components/stats-cards";
import { AgentTable } from "./components/agent-table";
import { RetryTable } from "./components/retry-table";
import { LogStream } from "./components/log-stream";

export function App() {
  const { snapshot, logs, connected, startTime, actions } = useSSE();

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <Header
        connected={connected}
        startTime={startTime}
        onForcePoll={actions.forcePoll}
        onRestart={actions.restart}
        onShutdown={actions.shutdown}
      />

      <main className="flex flex-col flex-1 min-h-0 p-6 gap-4">
        <StatsCards snapshot={snapshot} />

        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-2">Running Agents</h2>
            <AgentTable running={snapshot?.running ?? []} />
          </div>

          <RetryTable retrying={snapshot?.retrying ?? []} />
        </div>

        <LogStream logs={logs} />
      </main>
    </div>
  );
}
