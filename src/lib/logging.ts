import { createHash, randomUUID } from "node:crypto";
import { cleanMessage } from "@/lib/lots";

type LogLevel = "info" | "warn" | "error";
type LogDetails = Record<string, unknown>;

export function createTraceId(scope: string): string {
  return `${scope}-${randomUUID()}`;
}

export function fingerprintSecret(value?: string): string {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) {
    return "missing";
  }

  return `${createHash("sha256").update(cleaned).digest("hex").slice(0, 12)}:${cleaned.length}`;
}

export function logEvent(level: LogLevel, event: string, details: LogDetails = {}) {
  const payload = sanitizeLogObject({
    event,
    ...details,
  });
  const line = `[shiphero-lot-upload] ${JSON.stringify(payload)}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export function traceError(message: string, traceId?: string): Error {
  const error = new Error(message);
  if (traceId) {
    Object.assign(error, { traceId });
  }
  return error;
}

export function attachTraceId(error: unknown, traceId?: string): unknown {
  if (error instanceof Error && traceId && !readTraceId(error)) {
    Object.assign(error, { traceId });
  }
  return error;
}

export function readTraceId(error: unknown): string {
  if (error && typeof error === "object" && "traceId" in error) {
    return String((error as { traceId?: string }).traceId ?? "");
  }
  return "";
}

function sanitizeLogObject(details: LogDetails): LogDetails {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, sanitizeLogValue(key, value)]),
  );
}

function sanitizeLogValue(key: string, value: unknown): unknown {
  if (
    /token|authorization|secret/i.test(key) &&
    !/fingerprint|present|has/i.test(key)
  ) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    return cleanMessage(value).slice(0, 500);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item));
  }

  if (value && typeof value === "object") {
    return sanitizeLogObject(value as LogDetails);
  }

  return value;
}
