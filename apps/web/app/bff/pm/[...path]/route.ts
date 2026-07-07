import { type NextRequest, NextResponse } from "next/server";

// BFF proxy for the Cognitive-PM cockpit. The aito1_pm_* tables are owned by
// Brain (aito1-brain, FastAPI on :8082), auth-free and bound to localhost. The
// browser must NOT reach Brain directly — it hits this same-origin route, which
// gates on the multica session cookie and forwards server-side. Mirrors
// app/bff/monitoring. GET-only, with one deliberate exception — the trainer's
// gate over lessons: POST lesson/{id}/approve, lesson/{id}/reject and
// lesson/{id}/status are the ONLY mutations allowed from the UI (план junior-pm
// §3 «Кокпит» п.3, одобрено владельцем); every other /api/pm/* write stays with
// the agents.
//
// Mounted under /bff/ — NOT /api/ — because next.config rewrites /api/:path*
// wholesale to the Go backend, shadowing route handlers here.
const BRAIN_URL = process.env.AITO1_BRAIN_URL ?? "http://127.0.0.1:8082";

// First path segment must be one of these Brain /api/pm/* read surfaces — never
// an open relay. Note: /decisions/{pid}/resolved and /decisions/{pid}/overdue
// pass through the "decisions" entry (only path[0] is gated).
const ALLOWED = new Set([
  "checkpoints",
  "commitments",
  "decisions",
  "projects",
  "lessons",
  "lesson-events",
  "calibration",
  "error-metric",
  "owner-tasks",
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exactly three POST path shapes pass — the trainer's lesson gate. Anything else
// (other /pm/lesson/* ops, checkpoints, decisions, …) is 404: the allowlist is
// shape-based (segment count + literal segments + UUID), not prefix-based, so
// this can never quietly widen into an open relay.
function isAllowedPost(path: string[]): boolean {
  return (
    path.length === 3 &&
    path[0] === "lesson" &&
    UUID_RE.test(path[1] ?? "") &&
    (path[2] === "approve" || path[2] === "reject" || path[2] === "status")
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  if (!req.cookies.has("multica_logged_in")) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  if (!isAllowedPost(path)) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }

  // Body passes through as-is: approve and reject go body-less; status carries
  // {"status":"retired"|"quarantined","actor":"owner"} — validation is
  // Brain's (Pydantic LessonStatusRequest, 404 for a missing lesson).
  const body = await req.text();
  const sub = path.map((s) => encodeURIComponent(s)).join("/");
  const target = `${BRAIN_URL}/api/pm/${sub}`;
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers:
        body.length > 0
          ? { accept: "application/json", "content-type": "application/json" }
          : { accept: "application/json" },
      body: body.length > 0 ? body : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    const respBody = await upstream.text();
    return new NextResponse(respBody, {
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
