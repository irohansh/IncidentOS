import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { decideApproval } from '../../../dashboard/lib/db';

const ApproveSchema = z.object({
  step_id:    z.string().uuid(),
  decision:   z.enum(['approved', 'rejected']),
  decided_by: z.string().min(1).max(200),
});

function authenticate(req: NextRequest): NextResponse | null {
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (!apiKey) return null; // key not configured → open (dev mode)

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  // Timing-safe comparison to prevent timing attacks on the key
  if (token.length !== apiKey.length) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const a = Buffer.from(token);
  const b = Buffer.from(apiKey);
  // Both same length guaranteed above
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return null;
}

export async function POST(req: NextRequest) {
  const authErr = authenticate(req);
  if (authErr) return authErr;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ApproveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
  }

  const { step_id, decision, decided_by } = parsed.data;

  try {
    await decideApproval(step_id, decision, decided_by);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
