import { NextResponse, type NextRequest } from "next/server";

import { isIdentityConfigured } from "@/lib/identity";

/**
 * First-run gate (TMB-47/48): until an actor handle is configured (env or
 * stored config file), every page, route handler and server-function POST
 * redirects to /setup. Next 16's proxy always runs on the Node runtime, so
 * the synchronous config-file read in lib/identity is fine here. Root-level
 * infrastructure, not app/ code — it may consult lib/identity directly.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === "/setup" || isIdentityConfigured()) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/setup", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
