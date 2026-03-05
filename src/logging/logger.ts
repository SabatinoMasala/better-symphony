/**
 * Symphony Logger
 * Structured logging with key=value format
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  timestamp: Date;
  message: string;
  context: LogContext;
}

export type LogSink = (entry: LogEntry) => void;

class Logger {
  private sinks: LogSink[] = [];
  private minLevel: LogLevel = "info";

  private levelOrder: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  removeSink(sink: LogSink): void {
    const index = this.sinks.indexOf(sink);
    if (index !== -1) {
      this.sinks.splice(index, 1);
    }
  }

  clearSinks(): void {
    this.sinks.length = 0;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelOrder[level] >= this.levelOrder[this.minLevel];
  }

  private emit(level: LogLevel, message: string, context: LogContext = {}): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      timestamp: new Date(),
      message,
      context,
    };

    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        // Sink failure should not crash the service
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }
}

// Default console sink with key=value format
export function createConsoleSink(): LogSink {
  return (entry: LogEntry) => {
    const ts = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(5);

    let contextStr = "";
    for (const [key, value] of Object.entries(entry.context)) {
      if (value !== undefined && value !== null) {
        contextStr += ` ${key}=${JSON.stringify(value)}`;
      }
    }

    const output = `[${ts}] ${level} ${entry.message}${contextStr}`;

    switch (entry.level) {
      case "error":
        console.error(output);
        break;
      case "warn":
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  };
}

// File sink (appends to file)
export function createFileSink(filePath: string): LogSink {
  const file = Bun.file(filePath);
  const writer = file.writer();

  return (entry: LogEntry) => {
    const jsonLine = JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      message: entry.message,
      ...entry.context,
    });
    writer.write(jsonLine + "\n");
    writer.flush();
  };
}

// Global logger instance
export const logger = new Logger();

// Add default console sink
logger.addSink(createConsoleSink());
