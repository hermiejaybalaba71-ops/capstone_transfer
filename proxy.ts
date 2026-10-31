import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const protectedRoutes = ["/student", "/admin", "/faculty", "/ched"];
const publicOnlyRoutes = ["/login", "/register"];

function getCookieName(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const match = url.match(/https?:\/\/([^.]+)/);
  const projectRef = match ? match[1] : "xflsxzmniseetvkrddmj";
  return `sb-${projectRef}-auth-token`;
}

function decodeJwtPayload(token: string): { exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function extractExpiresAt(sessionValue: string | undefined): number | null {
  if (!sessionValue) return null;
  // The cookie stores a JSON envelope: {"access_token": "...", "expires_at": 123, ...}
  try {
    const parsed = JSON.parse(sessionValue);
    if (typeof parsed?.expires_at === "number") return parsed.expires_at;
  } catch {
    // fall through to JWT decode below
  }
  // Fallback: try decoding it as a raw JWT access token.
  const payload = decodeJwtPayload(sessionValue);
  if (payload && typeof payload.exp === "number") return payload.exp;
  return null;
}

function hasValidSession(sessionValue: string | undefined): boolean {
  const expiresAt = extractExpiresAt(sessionValue);
  if (expiresAt === null) return false;
  return expiresAt * 1000 > Date.now();
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const cookieName = getCookieName();
  const token = request.cookies.get(cookieName)?.value;
  const loggedIn = hasValidSession(token);
  const hasStaleCookie = !!token && !loggedIn;

  const isProtected = protectedRoutes.some((route) => pathname.startsWith(route));
  const isPublicOnly = publicOnlyRoutes.some((route) => pathname.startsWith(route));

  let response: NextResponse;
  if (isProtected && !loggedIn) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    response = NextResponse.redirect(loginUrl);
  } else if (isPublicOnly && loggedIn) {
    response = NextResponse.redirect(new URL("/", request.url));
  } else {
    response = NextResponse.next();
  }

  if (hasStaleCookie) {
    response.cookies.set(cookieName, "", { maxAge: 0, path: "/" });
  }

  return response;
}

export const config = {
  matcher: ["/student/:path*", "/admin/:path*", "/faculty/:path*", "/ched/:path*", "/login", "/register"],
};
