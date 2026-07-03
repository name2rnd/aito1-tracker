import { NextResponse, type NextRequest } from "next/server";
import { matchLocale, LOCALE_COOKIE } from "@multica/core/i18n";

// Old workspace-scoped route segments that existed before the URL refactor
// (pre-#1131). Any URL with these as the FIRST segment is a legacy URL that
// needs to be rewritten to /{slug}/{route}/... so old bookmarks, deep links,
// and post-revert-and-reapply users don't hit 404.
const LEGACY_ROUTE_SEGMENTS = new Set([
  "issues",
  "projects",
  "agents",
  "inbox",
  "my-issues",
  "autopilots",
  "runtimes",
  "skills",
  "settings",
]);

// AITO1-patch (Патч 40): login-less fork. Identity comes from a PAT held in
// localStorage (see identity-registry), not a login flow — so there is no
// `multica_logged_in` session cookie to gate on. The proxy therefore never
// bounces to /login; it just funnels every workspace-shaped or root URL into a
// concrete workspace so the app shell always renders. Default slug is
// overridable via env for non-`aito1` installs.
const DEFAULT_WORKSPACE_SLUG =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_SLUG || "aito1";

// Resolve the active locale per request. Cookie wins over Accept-Language;
// matchLocale() falls back to DEFAULT_LOCALE when neither yields a match.
function resolveLocale(req: NextRequest): string {
  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  const acceptLanguage = req.headers.get("accept-language") ?? "";
  const candidates: string[] = [];
  if (cookieLocale) candidates.push(cookieLocale);
  for (const part of acceptLanguage.split(",")) {
    const tag = part.split(";")[0]?.trim();
    if (tag) candidates.push(tag);
  }
  return matchLocale(candidates);
}

// Forward the resolved locale to RSC layouts via the `x-multica-locale`
// request header. layout.tsx reads it through `await headers()`. The
// `request: { headers }` form is what makes the header land on the upstream
// request — without it the value would only sit on the response.
function nextWithLocale(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set("x-multica-locale", resolveLocale(req));
  return NextResponse.next({ request: { headers } });
}

// Next.js 16 renamed `middleware` → `proxy`. API surface (NextRequest /
// NextResponse / cookies / matcher) is identical; the only behavioral
// change is the runtime — proxy is forced to nodejs and cannot opt into
// edge.
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Prefer the last workspace the operator viewed (layout writes this cookie);
  // fall back to the default slug. No session check — there is no login wall.
  const slug = req.cookies.get("last_workspace_slug")?.value || DEFAULT_WORKSPACE_SLUG;

  // --- Legacy URL redirect: /issues/... → /{slug}/issues/... ---
  // Old bookmarks and clients that hit us before the slug migration would
  // otherwise 404 since the route moved under [workspaceSlug]. Preserve the
  // deep-link path + query.
  const firstSegment = pathname.split("/")[1] ?? "";
  if (LEGACY_ROUTE_SEGMENTS.has(firstSegment)) {
    const url = req.nextUrl.clone();
    url.pathname = `/${slug}${pathname}`;
    return NextResponse.redirect(url);
  }

  // --- Root path: straight into the workspace board (no login gate) ---
  if (pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = `/${slug}/issues`;
    return NextResponse.redirect(url);
  }

  // --- Default: forward locale header to RSC, no redirect/rewrite ---
  // Covers /:slug/*, /login (the in-app identity picker), and everything else.
  return nextWithLocale(req);
}

export const config = {
  // i18n header must land on every page request, so we use the standard
  // negative-lookahead pattern from Next's i18n guide: skip API routes
  // (Go backend), Next internals, and any path with a file extension
  // (favicons, sw.js, public/* assets).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
