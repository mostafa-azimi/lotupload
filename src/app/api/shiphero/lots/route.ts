import { NextResponse } from "next/server";
import {
  cleanMessage,
  normalizeLotRow,
  normalizeRunOptions,
  type LotInputRow,
  type LotResult,
  type RunOptions,
} from "@/lib/lots";
import { createTraceId, fingerprintSecret, logEvent, readTraceId } from "@/lib/logging";
import { createLot, refreshAccessToken } from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const traceId = createTraceId("lots");

  try {
    const body = (await request.json()) as {
      refreshToken?: string;
      clientId?: string;
      rows?: LotInputRow[];
      options?: Partial<RunOptions>;
    };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const options = normalizeRunOptions(body.options);

    logEvent("info", "shiphero.lots.request.received", {
      traceId,
      rowCount: rows.length,
      dryRun: options.dryRun,
      stopOnError: options.stopOnError,
      throttleMs: options.throttleMs,
      hasClientId: Boolean(body.clientId?.trim()),
      hasRefreshToken: Boolean(body.refreshToken?.trim()),
      clientIdFingerprint: fingerprintSecret(body.clientId),
      refreshTokenFingerprint: fingerprintSecret(body.refreshToken),
    });

    if (!rows.length) {
      throw new Error("No CSV rows were provided.");
    }

    const accessToken = options.dryRun
      ? ""
      : await refreshAccessToken(body.refreshToken ?? "", body.clientId, {
          traceId,
          operation: "create-lots",
        });
    const results: LotResult[] = [];
    let halted = false;

    for (const row of rows) {
      let payload;
      try {
        payload = normalizeLotRow(row);

        if (options.dryRun) {
          results.push({
            rowNumber: row.rowNumber,
            status: "DRY_RUN",
            lotName: payload.name,
            sku: payload.sku,
            expiresAt: payload.expires_at ?? "",
            message: "Validated only.",
          });
        } else {
          const response = await createLot(accessToken, payload, {
            traceId,
            operation: "create-lots",
            rowNumber: row.rowNumber,
          });
          results.push({
            rowNumber: row.rowNumber,
            status: "CREATED",
            lotName: payload.name,
            sku: payload.sku,
            expiresAt: payload.expires_at ?? "",
            lotId: response.lot?.id ?? "",
            requestId: response.request_id ?? "",
            complexity: response.complexity ?? "",
            message: "Created.",
          });
        }
      } catch (error) {
        const status = isThrottleError(error) ? "THROTTLED" : "ERROR";
        logEvent(status === "THROTTLED" ? "warn" : "error", "shiphero.lots.row.failed", {
          traceId: readTraceId(error) || traceId,
          rowNumber: row?.rowNumber ?? "",
          status,
          shipheroRequestId: readRequestId(error),
          error: cleanMessage(error),
        });

        results.push({
          rowNumber: row?.rowNumber ?? "",
          status,
          lotName: payload?.name ?? "",
          sku: payload?.sku ?? "",
          expiresAt: payload?.expires_at ?? "",
          requestId: readRequestId(error),
          message: cleanMessage(error),
        });

        if (options.stopOnError || status === "THROTTLED") {
          halted = true;
          break;
        }
      }

      if (!options.dryRun && options.throttleMs > 0) {
        await sleep(options.throttleMs);
      }
    }

    logEvent(halted ? "warn" : "info", "shiphero.lots.request.completed", {
      traceId,
      rowCount: rows.length,
      resultCount: results.length,
      halted,
      createdCount: results.filter((result) => result.status === "CREATED").length,
      dryRunCount: results.filter((result) => result.status === "DRY_RUN").length,
      errorCount: results.filter((result) => result.status === "ERROR").length,
      throttledCount: results.filter((result) => result.status === "THROTTLED").length,
    });

    return NextResponse.json({
      ok: true,
      halted,
      results,
      traceId,
    });
  } catch (error) {
    const errorTraceId = readTraceId(error) || traceId;
    logEvent("error", "shiphero.lots.request.failed", {
      traceId: errorTraceId,
      error: cleanMessage(error),
    });

    return NextResponse.json(
      {
        ok: false,
        error: cleanMessage(error),
        traceId: errorTraceId,
      },
      { status: 400 },
    );
  }
}

function isThrottleError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "isThrottle" in error &&
      (error as { isThrottle?: boolean }).isThrottle,
  );
}

function readRequestId(error: unknown): string {
  if (error && typeof error === "object" && "requestId" in error) {
    return String((error as { requestId?: string }).requestId ?? "");
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
