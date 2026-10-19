import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { decideApproval, getApproval } from '../../../dashboard/lib/db';

const ApproveSchema = z.object({
  step_id:  z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  // decided_by is intentionally NOT accepted from the body — it comes from the session.
});

function checkOrigin(req: NextRequest): boolean {
  const dashboardUrl = process.env.DASHBOARD_PUBLIC_URL;
  if (!dashboardUrl) {
    // If ALLOW_INSECURE_DEV=true, skip origin check in non-production.
    if (process.env.ALLOW_INSECURE_DEV === 'true' && process.env.NODE_ENV !== 'production') {
      return true;
    }
    return false;
  }

  const expected = new URL(dashboardUrl);
  const origin = req.headers.get('origin') ?? req.headers.get('referer');
  if (!origin) return false;

  try {
    const actual = new URL(origin);
    return actual.host === expected.host;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Get session user from header set by middleware.
  const username = req.headers.get('x-session-user');
  const isApprover = req.headers.get('x-session-is-approver') === '1';

  if (!username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isApprover) {
    return NextResponse.json({ error: 'Forbidden — not an approver' }, { status: 403 });
  }

  if (!checkOrigin(req)) {
    return NextResponse.json({ error: 'Forbidden — invalid origin' }, { status: 403 });
  }

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

  const { step_id, decision } = parsed.data;

  // Check if already decided — idempotent protection.
  const existing = await getApproval(step_id);
  if (!existing) {
    return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
  }
  if (existing.decision !== null) {
    return NextResponse.json(
      { error: 'Already decided', decision: existing.decision, decided_by: existing.decided_by },
      { status: 409 }
    );
  }

  try {
    const rowCount = await decideApproval(step_id, decision, username);
    if (rowCount === 0) {
      return NextResponse.json({ error: 'Already decided or not found' }, { status: 409 });
    }
    return NextResponse.json({ ok: true, decided_by: username });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
