import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { formatDuration } from "../lib/utils";
import { RefreshCw, Power, RotateCcw } from "lucide-react";

interface HeaderProps {
  connected: boolean;
  startTime: number;
  onForcePoll: () => void;
  onRestart: () => void;
  onShutdown: () => void;
}

export function Header({ connected, startTime, onForcePoll, onRestart, onShutdown }: HeaderProps) {
  const [uptime, setUptime] = useState("0s");

  useEffect(() => {
    const timer = setInterval(() => {
      setUptime(formatDuration((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const [confirmAction, setConfirmAction] = useState<"restart" | "shutdown" | null>(null);

  const handleConfirm = () => {
    if (confirmAction === "restart") onRestart();
    if (confirmAction === "shutdown") onShutdown();
    setConfirmAction(null);
  };

  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-3">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">Better Symphony</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className={`h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-destructive"}`} />
          {connected ? "Connected" : "Disconnected"}
        </div>
        <span className="text-sm text-muted-foreground">Uptime: {uptime}</span>
      </div>

      <div className="flex items-center gap-2">
        {confirmAction ? (
          <>
            <span className="text-sm text-warning mr-2">
              Confirm {confirmAction}?
            </span>
            <Button size="sm" variant="destructive" onClick={handleConfirm}>Yes</Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmAction(null)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onForcePoll}>
              <RefreshCw className="h-3.5 w-3.5" />
              Poll Now
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmAction("restart")}>
              <RotateCcw className="h-3.5 w-3.5" />
              Restart
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmAction("shutdown")}>
              <Power className="h-3.5 w-3.5" />
              Shutdown
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
