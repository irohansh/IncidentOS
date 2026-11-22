import { runTriage } from './agents/triage';
import { runRootCause } from './agents/rootCause';
import { runComms } from './agents/comms';
import { runRunbook } from './agents/runbook';
import { runExecutor } from './agents/executor';
import { runValidator } from './agents/validator';
import { runPostmortem } from './agents/postmortem';
import { requestApproval, verifyCommandIntegrity } from './lib/approvalGate';
import { fetchMetrics } from './lib/metricsClient';
import { postCommsToSlack, createGithubIssue, fetchRecentDeploys } from './lib/integrations';
import { findMatchingRunbooks } from './lib/runbookLibrary';
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
  getRecentIncidents,
  getIncidentGithubIssueUrl,
  saveIncidentGithubIssueUrl,
  saveCheckpoint,
  loadCheckpoint,
} from './lib/incidentStore';
import { redactObject } from './lib/redact';
import { logger } from './lib/logger';
import type { AlertPayload, IncidentState, TimelineEvent } from './types/incident';

export type IncidentOutcome =
  | 'resolved'
  | 'mitigated'
  | 'unresolved'
  | 'rejected'
  | 'timed_out'
  | 'rolled_back'
  | 'no_actions'
  | 'failed';

// Per-incident persistence failure counter for P1.5 warning.
const persistFailCounts = new Map<string, number>();

async function persist(label: string, incidentId: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    logger.error('Persistence write failed after retries — continuing pipeline', {
      incident_id: incidentId,
      write: label,
      error: (err as Error).message,
    });
    const count = (persistFailCounts.get(incidentId) ?? 0) + 1;
    persistFailCounts.set(incidentId, count);
    if (count === 3) {
      logger.error('P1.5: 3 persistence failures on this incident — data may be incomplete', {
        incident_id: incidentId,
      });
    }
  }
}

async function checkpoint(incidentId: string, stage: string, state: IncidentState): Promise<void> {
  try {
    await saveCheckpoint(incidentId, stage, redactObject(state));
  } catch (err) {
    logger.warn('Checkpoint save failed — pipeline continues but resume may restart from earlier stage', {
      incident_id: incidentId, stage, error: (err as Error).message,
    });
  }
}

export async function runIncident(
  alert: AlertPayload,
  savedState?: IncidentState
): Promise<IncidentState> {
  // P3.3: Resume from checkpoint if provided; otherwise start fresh.
  const state: IncidentState = savedState ?? {
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

  if (!savedState) {
    addEvent(`Alert received: ${alert.title}`, 'system', 'detection');
  } else {
    addEvent(`Pipeline resumed from stage: ${savedState.triage ? (savedState.runbook ? 'runbook' : 'triage') : 'start'}`, 'system', 'action');
  }

  // ── Stage 1: Triage ────────────────────────────────────────────────────────
  if (!state.triage) {
    logger.info('Running Triage', { incident_id: alert.incident_id });
    const [metrics, recentIncidents] = await Promise.all([
      fetchMetrics(alert.affected_services ?? []),
      getRecentIncidents(5).catch(() => []),
    ]);
    state.triage = await runTriage(alert, metrics, recentIncidents);
    addEvent(
      `Triage complete: ${state.triage.severity} — ${state.triage.blast_radius}`,
      'agent', 'escalation'
    );
    await saveIncident(alert, state.triage);
    await persist('triage', alert.incident_id, () => saveTriage(alert.incident_id, state.triage!));
    await checkpoint(alert.incident_id, 'triage', state);
  } else {
    logger.info('Resuming — triage already complete', { incident_id: alert.incident_id });
  }

  // ── Stage 2: Root Cause + Comms in parallel ────────────────────────────────
  if (!state.root_cause && !state.comms) {
    logger.info('Running Root Cause + Comms in parallel', { incident_id: alert.incident_id });
  }

  let outcome: IncidentOutcome = 'unresolved';

  if (!state.root_cause) {
    const [rcResult, commsResult] = await Promise.allSettled([
      fetchRecentDeploys(alert.affected_services ?? []).then((deps) =>
        runRootCause(state, deps, [], [], [])
      ),
      state.comms
        ? Promise.resolve(state.comms)
        : runComms(state, {
            company_name:    process.env.COMPANY_NAME ?? 'Acme',
            product_name:    process.env.PRODUCT_NAME ?? 'Platform',
            status_page_url: process.env.STATUS_PAGE_URL ?? '',
            support_email:   process.env.SUPPORT_EMAIL ?? '',
          }),
    ]);

    if (rcResult.status === 'rejected') {
      logger.error('Root Cause agent failed — escalating, no runbook', {
        incident_id: alert.incident_id, error: rcResult.reason,
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
        incident_id: alert.incident_id, error: commsResult.reason,
      });
    } else if (commsResult.value && !state.comms) {
      state.comms = commsResult.value;
      await persist('comms', alert.incident_id, () =>
        saveComms(alert.incident_id, state.comms!)
      );
      await postCommsToSlack(alert.incident_id, state.comms).catch((e: Error) =>
        logger.error('Slack post failed', { incident_id: alert.incident_id, error: e.message })
      );
    }

    await checkpoint(alert.incident_id, 'parallel', state);
  } else {
    logger.info('Resuming — root cause + comms already complete', { incident_id: alert.incident_id });
  }

  if (outcome === 'failed') {
    await runPostmortemAndFinish(state, alert, outcome, addEvent, persist);
    return state;
  }

  // ── Stage 3: Runbook ───────────────────────────────────────────────────────
  if (!state.runbook) {
    logger.info('Running Runbook Agent', { incident_id: alert.incident_id });
    const topHyp = state.root_cause!.top_hypothesis;
    const matchingRunbooks = findMatchingRunbooks(
      alert.affected_services ?? [],
      topHyp.category,
      [topHyp.hypothesis, ...topHyp.supporting_evidence]
    );
    const runbookHints = matchingRunbooks.map((rb) => `${rb.id}: ${rb.title}`);
    state.runbook = await runRunbook(state, topHyp, matchingRunbooks, runbookHints);
    addEvent(`Runbook prepared: ${state.runbook.runbook_title}`, 'agent', 'action');
    await checkpoint(alert.incident_id, 'runbook', state);
  } else {
    logger.info('Resuming — runbook already complete', { incident_id: alert.incident_id });
  }

  if (!state.runbook.steps || state.runbook.steps.length === 0) {
    outcome = 'no_actions';
  } else {
    const stepIdMap = await saveRunbookSteps(alert.incident_id, state.runbook.steps);
    const completedStepNums = new Set(state.executor_results.map((r) => r.step_number));

    // ── Stage 4: Execute each step with human approval gate ──────────────────
    for (const step of state.runbook.steps) {
      if (completedStepNums.has(step.step_number)) {
        logger.info('Resuming — step already executed, skipping', {
          incident_id: alert.incident_id, step: step.step_number,
        });
        continue;
      }

      logger.info('Processing runbook step', {
        incident_id: alert.incident_id, step: step.step_number, title: step.title,
      });

      const requiresApproval =
        step.requires_approval || ['medium', 'high', 'critical'].includes(step.risk_level);

      if (requiresApproval) {
        const stepDbId = stepIdMap.get(step.step_number);

        if (!stepDbId) {
          logger.error('Step DB id missing for approval-required step — failing closed', {
            incident_id: alert.incident_id, step: step.step_number,
          });
          outcome = 'failed';
          addEvent(`Step ${step.step_number} failed: approval required but step not persisted`, 'system', 'escalation');
          break;
        }

        let approval;
        try {
          approval = await requestApproval(alert.incident_id, stepDbId, step);
        } catch (err) {
          logger.error('requestApproval threw — failing closed', {
            incident_id: alert.incident_id, step: step.step_number, error: (err as Error).message,
          });
          outcome = 'failed';
          addEvent(`Step ${step.step_number}: approval gate error — failing closed`, 'system', 'escalation');
          break;
        }

        if (approval.decision !== 'approved') {
          addEvent(`Step ${step.step_number} ${approval.decision} by human`, 'human', 'action');
          outcome = approval.decision === 'rejected' ? 'rejected'
            : approval.decision === 'timeout' ? 'timed_out'
            : 'failed';
          break;
        }

        addEvent(`Step ${step.step_number} approved by ${approval.decided_by ?? 'human'}`, 'human', 'action');

        // P5.1: Verify the command hasn't changed since approval was requested.
        if (!verifyCommandIntegrity(step.command, approval.command_sha256)) {
          logger.error('Command SHA-256 mismatch — aborting step, command may have been tampered', {
            incident_id: alert.incident_id, step: step.step_number,
          });
          outcome = 'failed';
          addEvent(`Step ${step.step_number}: command integrity check failed — aborting`, 'system', 'escalation');
          break;
        }
      }

      const metricsBefore = await fetchMetrics(alert.affected_services ?? []);

      const execResult = await runExecutor(state, step, undefined);
      state.executor_results.push(execResult);
      addEvent(`Step ${step.step_number} executed: ${execResult.action_taken}`, 'agent', 'action');

      const stepDbId = stepIdMap.get(step.step_number);
      if (stepDbId) {
        await persist('step_executed', alert.incident_id, () =>
          markStepExecuted(
            stepDbId,
            execResult.success ? (execResult.stdout ?? 'ok') : (execResult.error ?? 'failed')
          )
        );
      }

      await checkpoint(alert.incident_id, `step_${step.step_number}`, state);

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
      if (validation.verdict === 'unknown') {
        addEvent('Validator: metrics unavailable — unknown verdict, human confirmation required', 'agent', 'escalation');
        outcome = 'unresolved';
        break;
      }
      if (validation.resolved && validation.verdict === 'resolved') {
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

  if (outcome === 'resolved') {
    addEvent('Incident resolved — generating postmortem', 'agent', 'resolution');
  } else {
    addEvent(`Incident ended with outcome: ${outcome} — generating postmortem`, 'agent', 'escalation');
  }

  try {
    state.postmortem = await runPostmortem(state, resolvedAt, duration);
  } catch (err) {
    logger.error('Postmortem agent failed', {
      incident_id: alert.incident_id, error: (err as Error).message,
    });
  }

  if (state.postmortem) {
    const existingUrl = await getIncidentGithubIssueUrl(alert.incident_id).catch(() => null);
    if (existingUrl) {
      state.postmortem.github_issue_url = existingUrl;
    } else {
      const githubUrl = await createGithubIssue(
        state.postmortem.github_issue_title,
        state.postmortem.github_issue_body
      ).catch((e: Error) => {
        logger.error('GitHub issue creation failed', {
          incident_id: alert.incident_id, error: e.message,
        });
        return '';
      });

      if (githubUrl) {
        state.postmortem.github_issue_url = githubUrl;
        await persist('github_issue_url', alert.incident_id, () =>
          saveIncidentGithubIssueUrl(alert.incident_id, githubUrl)
        );
      }
    }

    await persist('postmortem', alert.incident_id, () =>
      savePostmortem(alert.incident_id, state.postmortem!)
    );
  }

  await persist('outcome', alert.incident_id, () =>
    updateIncidentOutcome(alert.incident_id, outcome)
  );

  logger.info('Incident pipeline complete', {
    incident_id: alert.incident_id, outcome, duration_min: duration,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
