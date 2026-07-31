/**
 * Mode A auth (08-AUTH-AND-DEPLOY.md §1): one shared password from CONSOLE_PASSWORD,
 * gated SERVER-SIDE. Next 16 renamed `middleware` → `proxy`.
 *
 * The cookie holds a hash of the password, never the password itself, so a stolen cookie
 * does not hand over the secret. This app stores App Store Connect keys that can read
 * financial reports — a client-side gate (as in aso-mindset-app) would be unacceptable here.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const COOKIE = "trysearch_session";

/** Derives the cookie value from the password. Not a KDF — it only has to be non-reversible-ish. */
export function sessionToken(password: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < password.length; i++) {
    const ch = password.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Public routes: the login flow, the cron trigger, diagnostics, and the marketing surface. */
const OPEN = ["/login", "/api/auth", "/api/cron", "/api/diag", "/aso-keyword-scores-explained"];

export function proxy(request: NextRequest) {
  const password = process.env.CONSOLE_PASSWORD;
  if (!password) return NextResponse.next(); // unconfigured = open, so local dev needs no setup

  const { pathname } = request.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  if (request.cookies.get(COOKIE)?.value === sessionToken(password)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
