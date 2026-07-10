import type { RunbookStep } from '../types/incident';
import { getPool } from './db';
import { logger } from './logger';

const pool = getPool();

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
  // Test mode: skip DB and immediately approve without blocking
  if (process.env.TEST_AUTO_APPROVE === 'true') {
    logger.info('TEST_AUTO_APPROVE — auto-approving step', { incident_id: incidentId, step: step.step_number });
    return { decision: 'approved', decided_by: 'test-runner', decided_at: new Date().toISOString() };
  }

  const timeoutMs = parseInt(process.env.APPROVAL_TIMEOUT_MS ?? String(5 * 60 * 1000), 10);
  const timeoutSeconds = Math.floor(timeoutMs / 1000);

  // Insert the approval request
  await pool.query(
    `INSERT INTO approval_requests
     (incident_id, step_id, timeout_seconds)
     VALUES ($1, $2, $3)`,
    [incidentId, stepId, timeoutSeconds]
  );

  // Poll every 3 seconds for up to timeoutMs
  const deadline = Date.now() + timeoutMs;
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
    `UPDATE approval_requests SET decision = 'timeout', decided_at = NOW()
     WHERE incident_id = $1 AND step_id = $2`,
    [incidentId, stepId]
  );
  return { decision: 'timeout' };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
