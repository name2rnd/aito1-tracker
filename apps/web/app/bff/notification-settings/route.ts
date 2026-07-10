import { type NextRequest, NextResponse } from "next/server";

// BFF proxy for the Telegram-notifications master switch. The flag lives in
// aito1_settings (`notifications.telegram.enabled`), owned by Brain (aito1-brain,
// FastAPI on :8082, auth-free, bound to localhost). The browser must NOT reach
// Brain directly — it hits this same-origin route (gated on the multica session
// cookie), which forwards to Brain's GET/PUT /api/settings/notifications.
//
// Mounted under /bff/ — NOT /api/ — because next.config rewrites `/api/:path*`
// wholesale to the Go backend, which would shadow a route handler here.
const BRAIN_URL = process.env.AITO1_BRAIN_URL ?? "http://127.0.0.1:8082";
const TARGET = `${BRAIN_URL}/api/settings/notifications`;
const UPSTREAM_TIMEOUT_MS = 10_000;

function forward(upstreamBody: string, status: number, contentType: string | null) {
  return new NextResponse(upstreamBody, {
    status,
    headers: { "content-type": contentType ?? "application/json" },
  });
}

export async function GET(req: NextRequest) {
  if (!req.cookies.has("multica_logged_in")) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }
  try {
    const upstream = await fetch(TARGET, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    return forward(await upstream.text(), upstream.status, upstream.headers.get("content-type"));
  } catch {
    return NextResponse.json({ detail: "settings service unreachable" }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  if (!req.cookies.has("multica_logged_in")) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }
  const body = await req.text();
  try {
    const upstream = await fetch(TARGET, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    return forward(await upstream.text(), upstream.status, upstream.headers.get("content-type"));
  } catch {
    return NextResponse.json({ detail: "settings service unreachable" }, { status: 502 });
  }
}
