import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: false } },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
