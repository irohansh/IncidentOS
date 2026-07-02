import { Pool } from 'pg';
import type { RunbookStep } from '../types/incident';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ApprovalResult {
  decision: 'approved' | 'rejected' | 'timeout';
  decided_by?: string;
  decided_at?: string;
}

// Insert approval request and poll until decision or timeout
export async function requestApproval(
  incidentId: string,
  stepId: string,
  step: RunbookStep
): Promise<ApprovalResult> {
  // Insert the approval request
  await pool.query(
    `INSERT INTO approval_requests
     (incident_id, step_id, timeout_seconds)
     VALUES ($1, $2, $3)`,
    [incidentId, stepId, 300]
  );

  // Poll every 3 seconds for up to APPROVAL_TIMEOUT_MS
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    const result = await pool.query(
      `SELECT decision, decided_by, decided_at
       FROM approval_requests
       WHERE incident_id = $1 AND step_id = $2
       AND decision IS NOT NULL`,
      [incidentId, stepId]
    );
    if (result.rows.length > 0) {
      return result.rows[0] as ApprovalResult;
    }
  }

  // Timeout — update the record and return
  await pool.query(
    `UPDATE approval_requests
     SET decision = 'timeout', decided_at = NOW()
     WHERE incident_id = $1 AND step_id = $2`,
    [incidentId, stepId]
  );
  return { decision: 'timeout' };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
