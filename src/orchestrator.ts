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
} from './lib/incidentStore';
import { logger } from './lib/logger';
import type {
  AlertPayload,
  IncidentState,
  TimelineEvent,
} from './types/incident';

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
  await saveTriage(alert.incident_id, state.triage);

  // ── Step 2: Root Cause + Comms in parallel ─────────────────────────────────
  logger.info('Running Root Cause + Comms in parallel', { incident_id: alert.incident_id });
  const [rootCause, comms] = await Promise.all([
    fetchRecentDeploys(alert.affected_services ?? []).then((deps) => runRootCause(state, deps)),
    runComms(state, {
      company_name:    process.env.COMPANY_NAME ?? 'Acme',
      product_name:    process.env.PRODUCT_NAME ?? 'Platform',
      status_page_url: process.env.STATUS_PAGE_URL ?? '',
      support_email:   process.env.SUPPORT_EMAIL ?? '',
    }),
  ]);
  state.root_cause = rootCause;
  state.comms = comms;
  addEvent(
    `Root cause analysis complete: ${rootCause.top_hypothesis.hypothesis}`,
    'agent', 'action'
  );

  await saveHypotheses(alert.incident_id, rootCause);
  await saveComms(alert.incident_id, comms);
  await postCommsToSlack(alert.incident_id, comms).catch((e: Error) =>
    logger.error('Slack post failed', { incident_id: alert.incident_id, error: e.message })
  );

  // ── Step 3: Runbook ────────────────────────────────────────────────────────
  logger.info('Running Runbook Agent', { incident_id: alert.incident_id });
  state.runbook = await runRunbook(state, rootCause.top_hypothesis);
  addEvent(`Runbook prepared: ${state.runbook.runbook_title}`, 'agent', 'action');

  const stepIdMap = await saveRunbookSteps(alert.incident_id, state.runbook.steps);

  // ── Step 4: Execute each step with human approval gate ────────────────────
  let lastExecResult = undefined;
  for (const step of state.runbook.steps) {
    logger.info('Processing runbook step', { incident_id: alert.incident_id, step: step.step_number, title: step.title });

    let approved = true;
    const stepDbId = stepIdMap.get(step.step_number);

    if (step.requires_approval && stepDbId) {
      logger.info('Awaiting human approval', { incident_id: alert.incident_id, step: step.step_number });
      const approval = await requestApproval(alert.incident_id, stepDbId, step);

      if (approval.decision !== 'approved') {
        addEvent(
          `Step ${step.step_number} ${approval.decision} by human`,
          'human', 'action'
        );
        if (approval.decision === 'rejected') {
          logger.info('Step rejected — stopping runbook', { incident_id: alert.incident_id, step: step.step_number });
          break;
        }
        if (approval.decision === 'timeout') {
          logger.warn('Approval timeout — escalating', { incident_id: alert.incident_id, step: step.step_number });
          break;
        }
        approved = false;
      }
    }

    if (!approved) continue;

    const execResult = await runExecutor(state, step, lastExecResult);
    lastExecResult = execResult;
    state.executor_results.push(execResult);
    addEvent(
      `Step ${step.step_number} executed: ${execResult.action_taken}`,
      'agent', 'action'
    );

    if (stepDbId) {
      await markStepExecuted(
        stepDbId,
        execResult.success ? (execResult.stdout ?? 'ok') : (execResult.error ?? 'failed')
      );
    }

    await sleep(parseInt(process.env.METRICS_INITIAL_DELAY_MS ?? '2000', 10));
    const metricsBefore = await fetchMetrics(alert.affected_services ?? []);
    await sleep(parseInt(process.env.METRICS_SAMPLE_DELAY_MS ?? '30000', 10));
    const metricsAfter = await fetchMetrics(alert.affected_services ?? []);

    const validation = await runValidator(state, execResult, step, metricsBefore, metricsAfter);
    state.validator_results.push(validation);
    addEvent(`Step ${step.step_number} validated: ${validation.verdict}`, 'agent', 'action');

    if (stepDbId) {
      await saveValidation(alert.incident_id, stepDbId, validation);
    }

    if (validation.recommendation === 'rollback') {
      addEvent('Validator recommends rollback — stopping runbook', 'agent', 'action');
      break;
    }
    if (validation.resolved) {
      addEvent('Incident resolved by validator confirmation', 'agent', 'mitigation');
      break;
    }
    if (execResult.next_step_recommendation === 'abort') {
      addEvent('Executor recommends abort — stopping runbook', 'agent', 'action');
      break;
    }
  }

  // ── Step 5: Postmortem ─────────────────────────────────────────────────────
  const resolvedAt = new Date().toISOString();
  const duration = Math.round(
    (new Date(resolvedAt).getTime() - new Date(state.started_at).getTime()) / 60000
  );
  addEvent('Incident resolved — generating postmortem', 'agent', 'resolution');

  state.postmortem = await runPostmortem(state, resolvedAt, duration);

  const githubUrl = await createGithubIssue(
    state.postmortem.github_issue_title,
    state.postmortem.github_issue_body
  ).catch((e: Error) => {
    logger.error('GitHub issue creation failed', { incident_id: alert.incident_id, error: e.message });
    return '';
  });

  if (githubUrl) {
    state.postmortem.github_issue_url = githubUrl;
  }

  await savePostmortem(alert.incident_id, state.postmortem);
  logger.info('Incident pipeline complete', { incident_id: alert.incident_id, duration_min: duration });

  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
