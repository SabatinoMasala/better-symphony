import { useState, useEffect, useCallback, useRef } from "react";

export interface LogLine {
  source: string;
  message: string;
  type: "line" | "error" | "info" | "comment";
  timestamp: number;
}

export interface RuntimeSnapshot {
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    state: string;
    started_at: string;
    turn_count: number;
    session_id: string | null;
    workflow: string | null;
  }>;
  retrying: Array<{
    issue_id: string;
    identifier: string;
    attempt: number;
    due_at: string;
    error: string | null;
    workflow: string | null;
  }>;
  workflows: Array<{
    name: string;
    max_concurrent_agents: number;
    running_count: number;
  }>;
  token_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  rate_limits: {
    requests_remaining: number;
    requests_limit: number;
    tokens_remaining: number;
    tokens_limit: number;
    reset_at: string;
  } | null;
}

const MAX_LOGS = 1000;

export function useSSE() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      setSnapshot(data.snapshot);

      if (data.type === "initial") {
        setLogs(data.logs ?? []);
      } else if (data.logs?.length) {
        setLogs((prev) => [...prev, ...data.logs].slice(-MAX_LOGS));
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => es.close();
  }, []);

  const forcePoll = useCallback(async () => {
    await fetch("/api/force-poll", { method: "POST" });
  }, []);

  const restart = useCallback(async () => {
    await fetch("/api/restart", { method: "POST" });
  }, []);

  const shutdown = useCallback(async () => {
    await fetch("/api/shutdown", { method: "POST" });
  }, []);

  return {
    snapshot,
    logs,
    connected,
    startTime: startTimeRef.current,
    actions: { forcePoll, restart, shutdown },
  };
}
