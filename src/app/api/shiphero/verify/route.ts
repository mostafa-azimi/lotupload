import { NextResponse } from "next/server";
import { cleanMessage } from "@/lib/lots";
import { createTraceId, fingerprintSecret, logEvent, readTraceId } from "@/lib/logging";
import { verifyAccessToken, verifyRefreshToken } from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const traceId = createTraceId("verify");

  try {
    const body = (await request.json()) as {
      authMode?: "refresh" | "access";
      refreshToken?: string;
      accessToken?: string;
      clientId?: string;
    };
    const authMode = body.authMode === "access" ? "access" : "refresh";

    logEvent("info", "shiphero.verify.request.received", {
      traceId,
      authMode,
      hasClientId: Boolean(body.clientId?.trim()),
      hasRefreshToken: Boolean(body.refreshToken?.trim()),
      hasAccessToken: Boolean(body.accessToken?.trim()),
      clientIdFingerprint: fingerprintSecret(body.clientId),
      refreshTokenFingerprint: fingerprintSecret(body.refreshToken),
      accessTokenFingerprint: fingerprintSecret(body.accessToken),
    });

    const result =
      authMode === "access"
        ? {
            account: await verifyAccessToken(body.accessToken ?? "", {
              traceId,
              operation: "verify-access-token",
            }),
            rotatedRefreshToken: "",
          }
        : await verifyRefreshToken(body.refreshToken ?? "", body.clientId, {
            traceId,
            operation: "verify-refresh-token",
          });

    logEvent("info", "shiphero.verify.request.succeeded", {
      traceId,
      authMode,
      accountId: result.account.accountId,
      userId: result.account.userId,
      shipheroRequestId: result.account.requestId,
      refreshTokenRotated: Boolean(result.rotatedRefreshToken),
    });

    return NextResponse.json({
      ok: true,
      authMode,
      account: result.account,
      rotatedRefreshToken: result.rotatedRefreshToken,
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
