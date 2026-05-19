import { NextRequest, NextResponse } from 'next/server';

/**
 * Middleware - Role-Based Access Control (RBAC)
 * Runs BEFORE reaching Route Handlers or Pages
 * TODO: Implement full RBAC when Firebase auth is ready
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // TODO: Add logic here:
  // 1. Extract auth token from cookies/session
  // 2. Verify user role (student, teacher, creator)
  // 3. Check if user has access to requested route
  // 4. Redirect to /auth if not authenticated
  // 5. Redirect to /403 if role mismatch

  // For now: allow all requests (placeholder)
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     * - public folder
     */
    '/((?!api|_next/static|_next/image|favicon.ico|public).*)',
  ],
};
