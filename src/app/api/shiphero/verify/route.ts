import { NextResponse } from "next/server";
import { cleanMessage } from "@/lib/lots";
import { verifyRefreshToken } from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      refreshToken?: string;
      clientId?: string;
    };
    const account = await verifyRefreshToken(body.refreshToken ?? "", body.clientId);

    return NextResponse.json({
      ok: true,
      account,
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
