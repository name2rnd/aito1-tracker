import { type NextRequest, NextResponse } from "next/server";

// BFF proxy for the Cognitive-PM cockpit. The aito1_pm_* tables are owned by
// Brain (aito1-brain, FastAPI on :8082), auth-free and bound to localhost. The
// browser must NOT reach Brain directly — it hits this same-origin route, which
// gates on the multica session cookie and forwards server-side. Mirrors
// app/bff/monitoring. Read-only (GET): the cockpit shows state, mutations stay
// in the agents' /api/pm/* writes.
//
// Mounted under /bff/ — NOT /api/ — because next.config rewrites /api/:path*
// wholesale to the Go backend, shadowing route handlers here.
const BRAIN_URL = process.env.AITO1_BRAIN_URL ?? "http://127.0.0.1:8082";

// First path segment must be one of these Brain /api/pm/* read surfaces — never
// an open relay.
const ALLOWED = new Set([
  "goal",
  "commitments",
  "decisions",
  "lessons",
  "error-metric",
]);

const UPSTREAM_TIMEOUT_MS = 10_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  if (!req.cookies.has("multica_logged_in")) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  if (path.length < 1 || !ALLOWED.has(path[0]!)) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const sub = path.map((s) => encodeURIComponent(s)).join("/");
  const target = `${BRAIN_URL}/api/pm/${sub}${req.nextUrl.search}`;
  try {
    const upstream = await fetch(target, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      { detail: "cognitive-pm service unreachable" },
      { status: 502 },
    );
  }
}
