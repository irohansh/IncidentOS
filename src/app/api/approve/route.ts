import { NextRequest, NextResponse } from 'next/server';
import { decideApproval } from '../../../dashboard/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { step_id, decision, decided_by } = await req.json() as {
      step_id: string;
      decision: 'approved' | 'rejected';
      decided_by: string;
    };

    if (!step_id || !decision || !decided_by) {
      return NextResponse.json({ error: 'Missing step_id, decision, or decided_by' }, { status: 400 });
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return NextResponse.json({ error: 'decision must be approved or rejected' }, { status: 400 });
    }

    await decideApproval(step_id, decision, decided_by);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
