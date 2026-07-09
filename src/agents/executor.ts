import { callAgent } from '../lib/callAgent';
import { executeCommand } from '../lib/commandExecutor';
import type { IncidentState, RunbookStep, ExecutorOutput } from '../types/incident';

// When ENABLE_REAL_EXECUTION=true, commands are run on the host via child_process.
// The LLM then analyzes the real output to produce action_taken and next_step_recommendation.
// Default is simulation mode — the LLM generates realistic output without running anything.
export async function runExecutor(
  incident: IncidentState,
  approvedStep: RunbookStep,
  previousResult?: ExecutorOutput
): Promise<ExecutorOutput> {
  const realMode =
    process.env.ENABLE_REAL_EXECUTION === 'true' &&
    approvedStep.command &&
    approvedStep.tool !== 'manual' &&
    approvedStep.tool !== 'slack';

  if (realMode && approvedStep.command) {
    const cmdResult = await executeCommand(approvedStep.command, approvedStep.timeout_seconds);

    return callAgent<ExecutorOutput>(
      'executor',
      {
        incident,
        approved_step: approvedStep,
        previous_step_result: previousResult,
        real_execution_result: cmdResult.blocked
          ? { blocked: true, blocked_reason: cmdResult.blocked_reason }
          : {
              stdout: cmdResult.stdout,
              stderr: cmdResult.stderr,
              exit_code: cmdResult.exit_code,
              duration_ms: cmdResult.duration_ms,
              success: cmdResult.exit_code === 0,
            },
      },
      incident.alert.incident_id
    );
  }

  // Simulation mode: LLM generates realistic execution output
  return callAgent<ExecutorOutput>(
    'executor',
    { incident, approved_step: approvedStep, previous_step_result: previousResult },
    incident.alert.incident_id
  );
}
