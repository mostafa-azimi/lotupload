import { NextResponse } from "next/server";
import { cleanMessage } from "@/lib/lots";
import { createTraceId, fingerprintSecret, logEvent, readTraceId } from "@/lib/logging";
import { verifyRefreshToken } from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const traceId = createTraceId("verify");

  try {
    const body = (await request.json()) as {
      refreshToken?: string;
      clientId?: string;
    };

    logEvent("info", "shiphero.verify.request.received", {
      traceId,
      hasClientId: Boolean(body.clientId?.trim()),
      hasRefreshToken: Boolean(body.refreshToken?.trim()),
      clientIdFingerprint: fingerprintSecret(body.clientId),
      refreshTokenFingerprint: fingerprintSecret(body.refreshToken),
    });

    const account = await verifyRefreshToken(body.refreshToken ?? "", body.clientId, {
      traceId,
      operation: "verify-account",
    });

    logEvent("info", "shiphero.verify.request.succeeded", {
      traceId,
      accountId: account.accountId,
      userId: account.userId,
      shipheroRequestId: account.requestId,
    });

    return NextResponse.json({
      ok: true,
      account,
      traceId,
    });
  } catch (error) {
    const errorTraceId = readTraceId(error) || traceId;
    logEvent("error", "shiphero.verify.request.failed", {
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
