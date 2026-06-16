import { NextResponse } from "next/server";
import {
  cleanMessage,
  normalizeLotRow,
  normalizeRunOptions,
  type LotInputRow,
  type LotResult,
  type RunOptions,
} from "@/lib/lots";
import { createLot, refreshAccessToken } from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      refreshToken?: string;
      clientId?: string;
      rows?: LotInputRow[];
      options?: Partial<RunOptions>;
    };
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const options = normalizeRunOptions(body.options);

    if (!rows.length) {
      throw new Error("No CSV rows were provided.");
    }

    const accessToken = options.dryRun
      ? ""
      : await refreshAccessToken(body.refreshToken ?? "", body.clientId);
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
          const response = await createLot(accessToken, payload);
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

    return NextResponse.json({
      ok: true,
      halted,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: cleanMessage(error),
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
