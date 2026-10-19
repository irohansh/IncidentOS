import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { createSessionToken, parseDashboardUsers, parseApprovers } from '../../../lib/session';

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { username, password } = parsed.data;
  const users = parseDashboardUsers();
  const hash = users.get(username);

  // Always run bcrypt compare (even with a dummy hash) to prevent user-enumeration via timing.
  const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  const valid = await bcrypt.compare(password, hash ?? DUMMY_HASH);

  if (!hash || !valid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const approvers = parseApprovers();
  const token = createSessionToken({ username, isApprover: approvers.has(username) });

  const isSecure = (process.env.NODE_ENV === 'production') && process.env.ALLOW_INSECURE_DEV !== 'true';
  const cookieParts = [
    `session=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=28800',
    'Path=/',
  ];
  if (isSecure) cookieParts.push('Secure');

  return NextResponse.json(
    { ok: true, username, isApprover: approvers.has(username) },
    { headers: { 'Set-Cookie': cookieParts.join('; ') } }
  );
}
