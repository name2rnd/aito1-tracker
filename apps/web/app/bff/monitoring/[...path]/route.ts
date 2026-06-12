import { type NextRequest, NextResponse } from "next/server";

// BFF proxy for the Monitoring section. The aito1_* tables are owned by Brain
// (aito1-brain, FastAPI on :8082), which is auth-free and bound to localhost.
// The browser must NOT reach Brain directly — it hits this same-origin route,
// which gates on the multica session cookie and forwards server-side.
//
// Mounted under /bff/ — NOT /api/ — because next.config rewrites `/api/:path*`
// wholesale to the Go backend (afterFiles), which would shadow a route handler
// here. /bff/ is matched by no rewrite, so this handler always runs.
const BRAIN_URL = process.env.AITO1_BRAIN_URL ?? "http://127.0.0.1:8082";

// Only these monitoring subpaths are proxied — never an open relay.
const ALLOWED = new Set([
  "fact-queries",
  "classes",
  "facts",
  "rules",
  "manners",
  "advice",
  "templates",
  "knowledges",
  "diary",
]);

// Most subpaths live under Brain's /api/monitoring/*; manners is the manners
// organ's own top-level endpoint (GET /api/manners, AITO-326) — same shape
// (read-only JSON), different mount point.
function brainTarget(sub: string, search: string): string {
  const base =
    sub === "manners"
      ? `${BRAIN_URL}/api/manners`
      : `${BRAIN_URL}/api/monitoring/${sub}`;
  return `${base}${search}`;
}

const UPSTREAM_TIMEOUT_MS = 10_000;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  if (!req.cookies.has("multica_logged_in")) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  if (path.length !== 1 || !ALLOWED.has(path[0]!)) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const target = brainTarget(path[0]!, req.nextUrl.search);
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
      { detail: "monitoring service unreachable" },
      { status: 502 },
    );
  }
}

// Human-driven mutation: drop a bad plan template. Scoped to exactly
// `templates/<id>` — no other path is delete-able. Same cookie gate as GET.
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  if (!req.cookies.has("multica_logged_in")) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  if (path.length !== 2 || path[0] !== "templates") {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  const target = `${BRAIN_URL}/api/monitoring/templates/${encodeURIComponent(path[1]!)}`;
  try {
    const upstream = await fetch(target, {
      method: "DELETE",
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
      { detail: "monitoring service unreachable" },
      { status: 502 },
    );
  }
}
