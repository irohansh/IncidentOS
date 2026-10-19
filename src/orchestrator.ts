import { runTriage } from './agents/triage';
import { runRootCause } from './agents/rootCause';
import { runComms } from './agents/comms';
import { runRunbook } from './agents/runbook';
import { runExecutor } from './agents/executor';
import { runValidator } from './agents/validator';
import { runPostmortem } from './agents/postmortem';
import { requestApproval } from './lib/approvalGate';
import { fetchMetrics } from './lib/metricsClient';
import { postCommsToSlack, createGithubIssue, fetchRecentDeploys } from './lib/mcpClient';
import {
  saveIncident,
  saveTriage,
  saveHypotheses,
  saveComms,
  saveRunbookSteps,
  markStepExecuted,
  saveValidation,
  savePostmortem,
  updateIncidentOutcome,
} from './lib/incidentStore';
import { logger } from './lib/logger';
import type {
  AlertPayload,
  IncidentState,
  TimelineEvent,
} from './types/incident';

export type IncidentOutcome =
  | 'resolved'
  | 'mitigated'
  | 'unresolved'
  | 'rejected'
  | 'timed_out'
  | 'rolled_back'
  | 'no_actions'
  | 'failed';

// Best-effort persistence: log and continue rather than abort in-progress remediation.
async function persist(label: string, incidentId: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    logger.error('Persistence write failed after retries — continuing pipeline', {
      incident_id: incidentId,
      write: label,
      error: (err as Error).message,
    });
  }
}

export async function runIncident(alert: AlertPayload): Promise<IncidentState> {
  const state: IncidentState = {
    alert,
    executor_results: [],
    validator_results: [],
    started_at: new Date().toISOString(),
    timeline: [],
  };

  const addEvent = (
    event: string,
    actor: TimelineEvent['actor'],
    significance: TimelineEvent['significance']
  ) => {
    state.timeline.push({ timestamp: new Date().toISOString(), event, actor, significance });
  };

  addEvent(`Alert received: ${alert.title}`, 'system', 'detection');

  // ── Step 1: Triage ─────────────────────────────────────────────────────────
  logger.info('Running Triage', { incident_id: alert.incident_id });
  const metrics = await fetchMetrics(alert.affected_services ?? []);
  state.triage = await runTriage(alert, metrics);
  addEvent(
    `Triage complete: ${state.triage.severity} — ${state.triage.blast_radius}`,
    'agent', 'escalation'
  );

  await saveIncident(alert, state.triage);
  await persist('triage', alert.incident_id, () => saveTriage(alert.incident_id, state.triage!));

  // ── Step 2: Root Cause + Comms in parallel (P3.4: allSettled so one failure doesn't discard the other)
  logger.info('Running Root Cause + Comms in parallel', { incident_id: alert.incident_id });
  const [rcResult, commsResult] = await Promise.allSettled([
    fetchRecentDeploys(alert.affected_services ?? []).then((deps) => runRootCause(state, deps)),
    runComms(state, {
      company_name:    process.env.COMPANY_NAME ?? 'Acme',
      product_name:    process.env.PRODUCT_NAME ?? 'Platform',
      status_page_url: process.env.STATUS_PAGE_URL ?? '',
      support_email:   process.env.SUPPORT_EMAIL ?? '',
    }),
  ]);

  let outcome: IncidentOutcome = 'unresolved';

  if (rcResult.status === 'rejected') {
    logger.error('Root Cause agent failed — escalating, no runbook', {
      incident_id: alert.incident_id,
      error: rcResult.reason,
    });
    outcome = 'failed';
  } else {
    state.root_cause = rcResult.value;
    addEvent(
      `Root cause analysis complete: ${rcResult.value.top_hypothesis.hypothesis}`,
      'agent', 'action'
    );
    await persist('hypotheses', alert.incident_id, () =>
      saveHypotheses(alert.incident_id, state.root_cause!)
    );
  }

  if (commsResult.status === 'rejected') {
    logger.error('Comms agent failed — continuing without comms draft', {
      incident_id: alert.incident_id,
      error: commsResult.reason,
    });
  } else {
    state.comms = commsResult.value;
    await persist('comms', alert.incident_id, () =>
      saveComms(alert.incident_id, state.comms!)
    );
    await postCommsToSlack(alert.incident_id, state.comms).catch((e: Error) =>
      logger.error('Slack post failed', { incident_id: alert.incident_id, error: e.message })
    );
  }

  if (outcome === 'failed') {
    // Root Cause failed — cannot generate runbook. Escalate and run postmortem.
    await runPostmortemAndFinish(state, alert, outcome, addEvent, persist);
    return state;
  }

  // ── Step 3: Runbook ────────────────────────────────────────────────────────
  logger.info('Running Runbook Agent', { incident_id: alert.incident_id });
  state.runbook = await runRunbook(state, state.root_cause!.top_hypothesis);
  addEvent(`Runbook prepared: ${state.runbook.runbook_title}`, 'agent', 'action');

  if (!state.runbook.steps || state.runbook.steps.length === 0) {
    outcome = 'no_actions';
  } else {
    const stepIdMap = await saveRunbookSteps(alert.incident_id, state.runbook.steps);

    // ── Step 4: Execute each step with human approval gate ──────────────────
    for (const step of state.runbook.steps) {
      logger.info('Processing runbook step', {
        incident_id: alert.incident_id,
        step: step.step_number,
        title: step.title,
      });

      // Code (not the AI) decides if approval is required.
      const requiresApproval =
        step.requires_approval ||
        ['medium', 'high', 'critical'].includes(step.risk_level);

      if (requiresApproval) {
        const stepDbId = stepIdMap.get(step.step_number);

        // P0.2: Fail closed — if DB id is missing, stop and escalate.
        if (!stepDbId) {
          logger.error('Step DB id missing for approval-required step — failing closed', {
            incident_id: alert.incident_id,
            step: step.step_number,
          });
          outcome = 'failed';
          addEvent(`Step ${step.step_number} failed: approval required but step not persisted`, 'system', 'escalation');
          break;
        }

        logger.info('Awaiting human approval', {
          incident_id: alert.incident_id,
          step: step.step_number,
        });

        let approval;
        try {
          approval = await requestApproval(alert.incident_id, stepDbId, step);
        } catch (err) {
          // requestApproval threw — fail closed, do not execute.
          logger.error('requestApproval threw — failing closed', {
            incident_id: alert.incident_id,
            step: step.step_number,
            error: (err as Error).message,
          });
          outcome = 'failed';
          addEvent(`Step ${step.step_number}: approval gate error — failing closed`, 'system', 'escalation');
          break;
        }

        if (approval.decision !== 'approved') {
          addEvent(
            `Step ${step.step_number} ${approval.decision} by human`,
            'human', 'action'
          );
          if (approval.decision === 'rejected') {
            outcome = 'rejected';
            break;
          }
          if (approval.decision === 'timeout') {
            outcome = 'timed_out';
            break;
          }
          // Unknown decision — fail closed.
          outcome = 'failed';
          break;
        }

        addEvent(`Step ${step.step_number} approved by ${approval.decided_by ?? 'human'}`, 'human', 'action');
      }

      // P4.6: Capture metricsBefore BEFORE executing the command.
      const metricsBefore = await fetchMetrics(alert.affected_services ?? []);

      const execResult = await runExecutor(state, step, undefined);
      state.executor_results.push(execResult);
      addEvent(
        `Step ${step.step_number} executed: ${execResult.action_taken}`,
        'agent', 'action'
      );

      const stepDbId = stepIdMap.get(step.step_number);
      if (stepDbId) {
        await persist('step_executed', alert.incident_id, () =>
          markStepExecuted(
            stepDbId,
            execResult.success ? (execResult.stdout ?? 'ok') : (execResult.error ?? 'failed')
          )
        );
      }

      // Wait then sample metrics after execution.
      await sleep(parseInt(process.env.METRICS_INITIAL_DELAY_MS ?? '2000', 10));
      const metricsAfter = await fetchMetrics(alert.affected_services ?? []);

      const validation = await runValidator(state, execResult, step, metricsBefore, metricsAfter);
      state.validator_results.push(validation);
      addEvent(`Step ${step.step_number} validated: ${validation.verdict}`, 'agent', 'action');

      if (stepDbId) {
        await persist('validation', alert.incident_id, () =>
          saveValidation(alert.incident_id, stepDbId, validation)
        );
      }

      if (validation.recommendation === 'rollback') {
        addEvent('Validator recommends rollback — stopping runbook', 'agent', 'action');
        outcome = 'rolled_back';
        break;
      }
      if (validation.resolved) {
        addEvent('Incident resolved by validator confirmation', 'agent', 'mitigation');
        outcome = 'resolved';
        break;
      }
      if (execResult.next_step_recommendation === 'abort') {
        addEvent('Executor recommends abort — stopping runbook', 'agent', 'action');
        outcome = 'unresolved';
        break;
      }
    }

    // If loop completed without resolution, mark unresolved.
    if (outcome === 'unresolved' && state.executor_results.length === 0) {
      outcome = 'no_actions';
    }
  }

  await runPostmortemAndFinish(state, alert, outcome, addEvent, persist);
  return state;
}

async function runPostmortemAndFinish(
  state: IncidentState,
  alert: AlertPayload,
  outcome: IncidentOutcome,
  addEvent: (event: string, actor: TimelineEvent['actor'], significance: TimelineEvent['significance']) => void,
  persist: (label: string, incidentId: string, op: () => Promise<unknown>) => Promise<void>
): Promise<void> {
  const resolvedAt = new Date().toISOString();
  const duration = Math.round(
    (new Date(resolvedAt).getTime() - new Date(state.started_at).getTime()) / 60000
  );

  // Only add a resolution event for truly resolved outcomes.
  if (outcome === 'resolved') {
    addEvent('Incident resolved — generating postmortem', 'agent', 'resolution');
  } else {
    addEvent(`Incident ended with outcome: ${outcome} — generating postmortem`, 'agent', 'escalation');
  }

  try {
    state.postmortem = await runPostmortem(state, resolvedAt, duration);
  } catch (err) {
    logger.error('Postmortem agent failed', {
      incident_id: alert.incident_id,
      error: (err as Error).message,
    });
  }

  if (state.postmortem) {
    const githubUrl = await createGithubIssue(
      state.postmortem.github_issue_title,
      state.postmortem.github_issue_body
    ).catch((e: Error) => {
      logger.error('GitHub issue creation failed', {
        incident_id: alert.incident_id,
        error: e.message,
      });
      return '';
    });

    if (githubUrl) {
      state.postmortem.github_issue_url = githubUrl;
    }

    await persist('postmortem', alert.incident_id, () =>
      savePostmortem(alert.incident_id, state.postmortem!)
    );
  }

  await persist('outcome', alert.incident_id, () =>
    updateIncidentOutcome(alert.incident_id, outcome)
  );

  logger.info('Incident pipeline complete', {
    incident_id: alert.incident_id,
    outcome,
    duration_min: duration,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
