import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, cookieName } from './lib/session';

// Routes that don't need authentication.
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/health']);

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Allow public paths.
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // Allow DASHBOARD_API_KEY for read-only API access (GET only).
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (apiKey && req.method === 'GET' && pathname.startsWith('/api/')) {
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token.length > 0 && token.length === apiKey.length) {
      try {
        const a = Buffer.from(token, 'utf8');
        const b = Buffer.from(apiKey, 'utf8');
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        if (diff === 0) return NextResponse.next();
      } catch {
        // fall through to session check
      }
    }
    // API key provided but invalid — reject immediately.
    if (auth.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Session cookie check.
  const sessionToken = req.cookies.get(cookieName())?.value;
  if (!sessionToken) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  let session;
  try {
    session = verifySessionToken(sessionToken);
  } catch {
    // SESSION_SECRET missing — return 503 in API context, redirect to login otherwise.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 503 });
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }

  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }

  // Inject username into request headers for downstream use.
  const headers = new Headers(req.headers);
  headers.set('x-session-user', session.username);
  headers.set('x-session-is-approver', session.isApprover ? '1' : '0');

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
