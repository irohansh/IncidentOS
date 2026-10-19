import { callAgent } from '../lib/callAgent';
import { executeCommand } from '../lib/commandExecutor';
import { redact } from '../lib/redact';
import type { IncidentState, RunbookStep, ExecutorOutput, ExecutionMode } from '../types/incident';

export async function runExecutor(
  incident: IncidentState,
  approvedStep: RunbookStep,
  previousResult?: ExecutorOutput
): Promise<ExecutorOutput> {
  const executionMode = (process.env.EXECUTION_MODE ?? 'simulated') as ExecutionMode;
  const canRun =
    approvedStep.command &&
    approvedStep.tool !== 'manual' &&
    approvedStep.tool !== 'slack';

  if (canRun && approvedStep.command && executionMode !== 'simulated') {
    const cmdResult = await executeCommand(approvedStep.command, approvedStep.timeout_seconds);

    // Code builds the factual result; only action_taken + next_step_recommendation come from the AI.
    const aiResult = await callAgent<Pick<ExecutorOutput, 'action_taken' | 'next_step_recommendation'>>(
      'executor',
      {
        incident_id: incident.alert.incident_id,
        approved_step: approvedStep,
        previous_step_result: previousResult,
        execution_result: cmdResult.blocked
          ? { blocked: true, blocked_reason: cmdResult.blocked_reason }
          : {
              stdout: redact(cmdResult.stdout),
              stderr: redact(cmdResult.stderr),
              exit_code: cmdResult.exit_code,
              duration_ms: cmdResult.duration_ms,
              success: cmdResult.exit_code === 0,
              execution_mode: cmdResult.execution_mode,
            },
      },
      incident.alert.incident_id
    );

    return {
      incident_id: incident.alert.incident_id,
      step_number: approvedStep.step_number,
      action_taken: aiResult.action_taken,
      command_executed: approvedStep.command,
      stdout: cmdResult.blocked ? undefined : redact(cmdResult.stdout),
      stderr: cmdResult.blocked ? undefined : redact(cmdResult.stderr),
      exit_code: cmdResult.blocked ? 1 : cmdResult.exit_code,
      duration_ms: cmdResult.duration_ms,
      success: !cmdResult.blocked && cmdResult.exit_code === 0,
      error: cmdResult.blocked ? cmdResult.blocked_reason : undefined,
      next_step_recommendation: aiResult.next_step_recommendation,
      execution_mode: cmdResult.execution_mode,
    };
  }

  // Simulation mode: LLM generates realistic execution output — clearly labelled.
  const simResult = await callAgent<Omit<ExecutorOutput, 'execution_mode'>>(
    'executor',
    {
      incident_id: incident.alert.incident_id,
      approved_step: approvedStep,
      previous_step_result: previousResult,
      execution_mode: 'simulated',
    },
    incident.alert.incident_id
  );

  return { ...simResult, execution_mode: 'simulated' };
}
