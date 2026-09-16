import { redact } from "@/lib/redact";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogMeta = Record<string, unknown>;

interface LogEntry {
  level: LogLevel;
  time: string;
  message: string;
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, meta: LogMeta = {}): void {
  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(redact(meta) as LogMeta),
  };

  const line = JSON.stringify(entry);

  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Returns a logger that merges `context` into every subsequent call's meta. */
  child(context: LogMeta): Logger;
}

function createLogger(baseContext: LogMeta = {}): Logger {
  return {
    debug: (message, meta) => write("debug", message, { ...baseContext, ...meta }),
    info: (message, meta) => write("info", message, { ...baseContext, ...meta }),
    warn: (message, meta) => write("warn", message, { ...baseContext, ...meta }),
    error: (message, meta) => write("error", message, { ...baseContext, ...meta }),
    child: (context) => createLogger({ ...baseContext, ...context }),
  };
}

export const logger = createLogger();
