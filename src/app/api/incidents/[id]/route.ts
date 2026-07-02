import { NextRequest, NextResponse } from 'next/server';
import {
  getIncident,
  getRunbookSteps,
  getPendingApprovals,
  getAgentLogs,
  getTriageSummary,
  getTopHypothesis,
  getPostmortem,
} from '../../../../dashboard/lib/db';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = params.id;
    const [incident, steps, triage, hypothesis, postmortem, logs] = await Promise.all([
      getIncident(id),
      getRunbookSteps(id),
      getTriageSummary(id),
      getTopHypothesis(id),
      getPostmortem(id),
      getAgentLogs(id),
    ]);

    // Get all approvals for this incident (not just pending)
    const approvalsResult = await pool.query(
      `SELECT ar.* FROM approval_requests ar
       WHERE ar.incident_id = $1 ORDER BY ar.requested_at`,
      [id]
    );

    return NextResponse.json({
      incident,
      steps,
      approvals: approvalsResult.rows,
      triage,
      hypothesis,
      postmortem,
      logs,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
