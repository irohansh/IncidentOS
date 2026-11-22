import crypto from 'crypto';
import type { RunbookStep } from '../types/incident';
import { query } from './db';
import { logger } from './logger';

export interface ApprovalResult {
  decision: 'approved' | 'rejected' | 'timeout';
  decided_by?: string;
  decided_at?: string;
  command_sha256?: string;
}

export function commandSha256(command: string | undefined): string | null {
  if (!command) return null;
  return crypto.createHash('sha256').update(command, 'utf8').digest('hex');
}

export async function requestApproval(
  incidentId: string,
  stepId: string,
  step: RunbookStep
): Promise<ApprovalResult> {
  if (process.env.TEST_AUTO_APPROVE === 'true') {
    logger.info('TEST_AUTO_APPROVE — auto-approving step', { incident_id: incidentId, step: step.step_number });
    return {
      decision: 'approved',
      decided_by: 'test-runner',
      decided_at: new Date().toISOString(),
      command_sha256: commandSha256(step.command) ?? undefined,
    };
  }

  const timeoutMs = parseInt(process.env.APPROVAL_TIMEOUT_MS ?? String(5 * 60 * 1000), 10);
  const timeoutSeconds = Math.floor(timeoutMs / 1000);
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  const sha256 = commandSha256(step.command);

  await query(
    `INSERT INTO approval_requests
       (incident_id, step_id, timeout_seconds, command, rollback_command,
        risk_level, command_sha256, expires_at, execution_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      incidentId,
      stepId,
      timeoutSeconds,
      step.command ?? null,
      step.rollback_command ?? null,
      step.risk_level,
      sha256,
      expiresAt,
      process.env.EXECUTION_MODE ?? 'simulated',
    ]
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const result = await query<ApprovalResult>(
      `SELECT decision, decided_by, decided_at, command_sha256
       FROM approval_requests
       WHERE incident_id = $1 AND step_id = $2 AND decision IS NOT NULL`,
      [incidentId, stepId]
    );
    if (result.rows.length > 0) {
      return result.rows[0];
    }
  }

  await query(
    `UPDATE approval_requests SET decision = 'timeout', decided_at = NOW()
     WHERE incident_id = $1 AND step_id = $2`,
    [incidentId, stepId]
  );
  return { decision: 'timeout' };
}

// Recompute SHA-256 of the command and compare with what was stored at approval time.
// Returns true if they match (or if no command / no hash to compare).
export function verifyCommandIntegrity(
  command: string | undefined,
  storedSha256: string | undefined
): boolean {
  if (!command || !storedSha256) return true;
  const actual = commandSha256(command);
  return actual === storedSha256;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
