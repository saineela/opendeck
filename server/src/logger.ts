type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL: Level =
  (process.env.LOG_LEVEL as Level | undefined) && process.env.LOG_LEVEL! in LEVEL_ORDER
    ? (process.env.LOG_LEVEL as Level)
    : process.env.NODE_ENV === "test"
      ? "error"
      : "info";

const SENSITIVE_KEY_PATTERN =
  /cookie|authorization|token|credential|secret|password|sapisid|apisid|sid|signature|code/i;

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    }
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitize(childValue, childKey, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const line = context
    ? `[${level}] ${message} ${JSON.stringify(sanitize(context))}`
    : `[${level}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
