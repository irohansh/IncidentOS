import { NextRequest, NextResponse } from 'next/server';
import {
  getIncident,
  getRunbookSteps,
  getAgentLogs,
  getTriageSummary,
  getTopHypothesis,
  getPostmortem,
  getAllApprovals,
} from '../../../../dashboard/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [incident, steps, triage, hypothesis, postmortem, logs, approvals] = await Promise.all([
      getIncident(id),
      getRunbookSteps(id),
      getTriageSummary(id),
      getTopHypothesis(id),
      getPostmortem(id),
      getAgentLogs(id),
      getAllApprovals(id),
    ]);

    return NextResponse.json({ incident, steps, approvals, triage, hypothesis, postmortem, logs });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
