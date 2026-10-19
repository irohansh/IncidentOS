import crypto from 'crypto';

export interface SessionData {
  username: string;
  isApprover: boolean;
  iat: number; // issued at (unix seconds)
}

const MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours
const COOKIE_NAME = 'session';

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return Buffer.from(s, 'utf8');
}

export function createSessionToken(data: Omit<SessionData, 'iat'>): string {
  const payload: SessionData = { ...data, iat: Math.floor(Date.now() / 1000) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionData | null {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const encoded = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);

  const expectedSig = crypto.createHmac('sha256', secret()).update(encoded).digest('base64url');

  // Timing-safe comparison.
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(expectedSig, 'base64url'))) {
      return null;
    }
  } catch {
    return null;
  }

  let data: SessionData;
  try {
    data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionData;
  } catch {
    return null;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
  if (ageSeconds > MAX_AGE_SECONDS) return null;

  return data;
}

export function cookieName(): string {
  return COOKIE_NAME;
}

export function cookieOptions(secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'Path=/',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseApprovers(): Set<string> {
  return new Set(
    (process.env.APPROVER_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// Returns parsed DASHBOARD_USERS map: username → bcrypt hash
export function parseDashboardUsers(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.DASHBOARD_USERS ?? '';
  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const name = entry.slice(0, colonIdx).trim();
    const hash = entry.slice(colonIdx + 1).trim();
    if (name && hash) map.set(name, hash);
  }
  return map;
}
