// Set fast-test defaults before any pipeline modules load env vars at call time.
// dotenv still wins for DATABASE_URL / ANTHROPIC_API_KEY (pool init happens at import).
process.env.METRICS_INITIAL_DELAY_MS ??= '500';
process.env.METRICS_SAMPLE_DELAY_MS  ??= '2000';
process.env.TEST_AUTO_APPROVE        ??= 'true';

import 'dotenv/config';
import { runIncident } from '../orchestrator';
import { sampleAlert } from './fixtures/sample-alert';
import type {
  IncidentState,
  Severity,
  Hypothesis,
} from '../types/incident';

// ── Typed valid-value sets ────────────────────────────────────────────────────

const SEVERITY_VALUES = new Set<Severity>(['P0', 'P1', 'P2', 'P3']);
const CATEGORY_VALUES = new Set<Hypothesis['category']>([
  'deployment', 'infrastructure', 'database', 'external_dependency',
  'traffic_spike', 'configuration', 'bug', 'unknown',
]);
const VERDICT_VALUES       = new Set(['resolved', 'improving', 'no_change', 'degraded']);
const RECOMMEND_VALUES     = new Set(['mark_resolved', 'continue_runbook', 'rollback', 'escalate']);
const NEXT_STEP_VALUES     = new Set(['proceed', 'wait_and_validate', 'abort', 'escalate']);
const RISK_LEVELS          = new Set(['safe', 'low', 'medium', 'high', 'critical']);
const APPROVAL_RISK_LEVELS = new Set(['medium', 'high', 'critical']);

// ── Check helpers ─────────────────────────────────────────────────────────────

interface Check { name: string; pass: boolean; }

function ok(name: string, condition: boolean): Check {
  return { name, pass: condition };
}

// ── Validators ────────────────────────────────────────────────────────────────

function validateState(state: IncidentState): Check[] {
  const c: Check[] = [];
  const id = state.alert.incident_id;

  // ── Triage ──────────────────────────────────────────────────────────────────
  const t = state.triage;
  c.push(ok('triage.present', !!t));
  if (t) {
    c.push(ok('triage.incident_id_match',       t.incident_id === id));
    c.push(ok('triage.severity_valid',          SEVERITY_VALUES.has(t.severity)));
    c.push(ok('triage.affected_services_nonempty', t.affected_services.length > 0));
    c.push(ok('triage.blast_radius_nonempty',   t.blast_radius.length > 0));
    c.push(ok('triage.customer_impact_nonempty',t.customer_impact.length > 0));
    c.push(ok('triage.confidence_in_range',     t.confidence >= 0 && t.confidence <= 100));
    c.push(ok('triage.metrics_snapshot_present',!!t.metrics_snapshot?.fetched_at));
    c.push(ok('triage.recommended_ic_nonempty', typeof t.recommended_ic === 'string' && t.recommended_ic.length > 0));
    c.push(ok('triage.war_room_is_bool',        typeof t.war_room_needed === 'boolean'));
    c.push(ok('triage.needs_escalation_is_bool',typeof t.needs_escalation === 'boolean'));
  }

  // ── Root Cause ───────────────────────────────────────────────────────────────
  const rc = state.root_cause;
  c.push(ok('root_cause.present', !!rc));
  if (rc) {
    c.push(ok('root_cause.incident_id_match',   rc.incident_id === id));
    c.push(ok('root_cause.hypotheses_nonempty', rc.hypotheses.length > 0));
    c.push(ok('root_cause.top_hypothesis_present', !!rc.top_hypothesis));
    c.push(ok('root_cause.confidence_in_range', rc.confidence >= 0 && rc.confidence <= 100));
    c.push(ok('root_cause.investigation_summary_nonempty',
      typeof rc.investigation_summary === 'string' && rc.investigation_summary.length > 0));
    if (rc.top_hypothesis) {
      const h = rc.top_hypothesis;
      c.push(ok('root_cause.top.category_valid',           CATEGORY_VALUES.has(h.category)));
      c.push(ok('root_cause.top.confidence_in_range',      h.confidence >= 0 && h.confidence <= 100));
      c.push(ok('root_cause.top.supporting_evidence_array',Array.isArray(h.supporting_evidence)));
      c.push(ok('root_cause.top.hypothesis_nonempty',      h.hypothesis.length > 0));
    }
    // All hypotheses are rank-ordered and have required fields
    const hypsValid = rc.hypotheses.every(
      h => typeof h.rank === 'number' && h.hypothesis.length > 0 && CATEGORY_VALUES.has(h.category)
    );
    c.push(ok('root_cause.hypotheses_well_formed', hypsValid));
  }

  // ── Comms ────────────────────────────────────────────────────────────────────
  const comms = state.comms;
  c.push(ok('comms.present', !!comms));
  if (comms) {
    c.push(ok('comms.incident_id_match',    comms.incident_id === id));
    c.push(ok('comms.drafts_nonempty',      comms.drafts.length > 0));
    c.push(ok('comms.has_internal_draft',   comms.drafts.some(d => d.audience === 'internal')));
    c.push(ok('comms.all_drafts_have_body', comms.drafts.every(d => d.body.length > 0)));
    c.push(ok('comms.do_not_say_array',     Array.isArray(comms.do_not_say)));
    c.push(ok('comms.severity_label_nonempty',
      typeof comms.suggested_severity_label === 'string' && comms.suggested_severity_label.length > 0));
  }

  // ── Runbook ──────────────────────────────────────────────────────────────────
  const rb = state.runbook;
  c.push(ok('runbook.present', !!rb));
  if (rb) {
    c.push(ok('runbook.incident_id_match', rb.incident_id === id));
    c.push(ok('runbook.steps_nonempty',    rb.steps.length > 0));
    c.push(ok('runbook.confidence_in_range', rb.confidence >= 0 && rb.confidence <= 100));
    c.push(ok('runbook.steps_count_max_8', rb.steps.length <= 8));
    c.push(ok('runbook.runbook_title_nonempty', rb.runbook_title.length > 0));

    const stepsWellFormed = rb.steps.every(
      s => typeof s.step_number === 'number'
        && s.action.length > 0
        && typeof s.requires_approval === 'boolean'
        && typeof s.timeout_seconds === 'number'
        && RISK_LEVELS.has(s.risk_level)
    );
    c.push(ok('runbook.steps_well_formed', stepsWellFormed));

    // Runbook contract: medium/high/critical steps must require approval
    const approvalRulesHeld = rb.steps
      .filter(s => APPROVAL_RISK_LEVELS.has(s.risk_level))
      .every(s => s.requires_approval === true);
    c.push(ok('runbook.approval_rules_match_risk', approvalRulesHeld));
  }

  // ── Executor (one per executed step) ────────────────────────────────────────
  c.push(ok('executor_results.is_array', Array.isArray(state.executor_results)));
  for (const ex of state.executor_results) {
    const pfx = `executor[step=${ex.step_number}]`;
    c.push(ok(`${pfx}.incident_id_match`,          ex.incident_id === id));
    c.push(ok(`${pfx}.action_taken_nonempty`,       ex.action_taken.length > 0));
    c.push(ok(`${pfx}.success_is_bool`,             typeof ex.success === 'boolean'));
    c.push(ok(`${pfx}.duration_ms_nonneg`,          ex.duration_ms >= 0));
    c.push(ok(`${pfx}.next_step_recommendation`,    NEXT_STEP_VALUES.has(ex.next_step_recommendation)));
    // Contract: non-zero exit_code → success must be false
    if (typeof ex.exit_code === 'number' && ex.exit_code !== 0) {
      c.push(ok(`${pfx}.non_zero_exit_implies_not_success`, ex.success === false));
    }
  }

  // ── Validator (one per executed step) ───────────────────────────────────────
  c.push(ok('validator_results.is_array', Array.isArray(state.validator_results)));
  for (const v of state.validator_results) {
    const pfx = `validator[step=${v.step_number}]`;
    c.push(ok(`${pfx}.incident_id_match`,  v.incident_id === id));
    c.push(ok(`${pfx}.verdict_valid`,      VERDICT_VALUES.has(v.verdict)));
    c.push(ok(`${pfx}.recommendation_valid`, RECOMMEND_VALUES.has(v.recommendation)));
    c.push(ok(`${pfx}.confidence_in_range`,v.confidence >= 0 && v.confidence <= 100));
    c.push(ok(`${pfx}.notes_nonempty`,     v.notes.length > 0));
    c.push(ok(`${pfx}.resolved_is_bool`,   typeof v.resolved === 'boolean'));
    // Contract: degraded verdict → recommendation must be rollback
    if (v.verdict === 'degraded') {
      c.push(ok(`${pfx}.degraded_implies_rollback`, v.recommendation === 'rollback'));
    }
  }

  // ── Postmortem ───────────────────────────────────────────────────────────────
  const pm = state.postmortem;
  c.push(ok('postmortem.present', !!pm));
  if (pm) {
    c.push(ok('postmortem.incident_id_match',        pm.incident_id === id));
    c.push(ok('postmortem.title_nonempty',           pm.title.length > 0));
    c.push(ok('postmortem.severity_valid',           SEVERITY_VALUES.has(pm.severity)));
    c.push(ok('postmortem.root_cause_nonempty',      pm.root_cause.length > 0));
    c.push(ok('postmortem.customer_impact_nonempty', pm.customer_impact.length > 0));
    c.push(ok('postmortem.detection_gap_nonempty',   pm.detection_gap.length > 0));
    c.push(ok('postmortem.draft_markdown_substantial',pm.draft_markdown.length > 100));
    c.push(ok('postmortem.action_items_nonempty',    pm.action_items.length > 0));
    c.push(ok('postmortem.five_whys_min3',           pm.five_whys.length >= 3));
    c.push(ok('postmortem.what_went_well_nonempty',  pm.what_went_well.length > 0));
    c.push(ok('postmortem.what_went_poorly_nonempty',pm.what_went_poorly.length > 0));
    c.push(ok('postmortem.contributing_factors_nonempty', pm.contributing_factors.length > 0));
    c.push(ok('postmortem.github_issue_title_nonempty', pm.github_issue_title.length > 0));
    c.push(ok('postmortem.github_issue_body_nonempty',  pm.github_issue_body.length > 0));
    c.push(ok('postmortem.duration_minutes_positive',   pm.duration_minutes >= 0));
    // All action items have required fields
    const itemsValid = pm.action_items.every(
      a => a.title.length > 0 && a.description.length > 0
        && ['P0','P1','P2'].includes(a.priority)
        && typeof a.due_days === 'number'
    );
    c.push(ok('postmortem.action_items_well_formed', itemsValid));
    // All five_whys have required fields
    const whysValid = pm.five_whys.every(
      w => typeof w.why_number === 'number' && w.question.length > 0 && w.answer.length > 0
    );
    c.push(ok('postmortem.five_whys_well_formed', whysValid));
  }

  // ── Timeline ─────────────────────────────────────────────────────────────────
  c.push(ok('timeline.nonempty',      state.timeline.length > 0));
  c.push(ok('timeline.has_detection', state.timeline.some(e => e.significance === 'detection')));
  c.push(ok('timeline.has_resolution',state.timeline.some(e => e.significance === 'resolution')));
  c.push(ok('timeline.all_have_timestamp',
    state.timeline.every(e => typeof e.timestamp === 'string' && e.timestamp.length > 0)));

  return c;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();

  console.log('='.repeat(60));
  console.log('IncidentOS — Pipeline Test Runner');
  console.log('='.repeat(60));
  console.log(`Alert : ${sampleAlert.incident_id}`);
  console.log(`Title : ${sampleAlert.title}`);
  console.log(`Config: METRICS_SAMPLE_DELAY_MS=${process.env.METRICS_SAMPLE_DELAY_MS}  TEST_AUTO_APPROVE=${process.env.TEST_AUTO_APPROVE}`);
  console.log('');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('FATAL: ANTHROPIC_API_KEY is not set. Copy .env.example → .env and fill in values.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.warn('WARN: DATABASE_URL not set — Postgres persistence will fail.\n');
  }

  // ── Run the full pipeline ────────────────────────────────────────────────────
  let state: IncidentState;
  try {
    state = await runIncident(sampleAlert);
  } catch (err) {
    console.error('\nFATAL: Pipeline threw an error:');
    console.error(err);
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nPipeline completed in ${elapsed}s`);

  // ── Validate outputs ─────────────────────────────────────────────────────────
  const checks = validateState(state);
  const passed  = checks.filter(c => c.pass);
  const failed  = checks.filter(c => !c.pass);

  console.log('\n' + '='.repeat(60));
  console.log(`Validation: ${passed.length} passed, ${failed.length} failed (${checks.length} total)`);
  console.log('='.repeat(60));

  if (failed.length > 0) {
    console.log('\nFAILED:');
    failed.forEach(c => console.log(`  ✗  ${c.name}`));
  }
  console.log('\nPASSED:');
  passed.forEach(c => console.log(`  ✓  ${c.name}`));

  // ── Human-readable summary ───────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Severity              : ${state.triage?.severity ?? 'n/a'}`);
  console.log(`Top hypothesis        : ${(state.root_cause?.top_hypothesis?.hypothesis ?? 'n/a').slice(0, 80)}`);
  console.log(`Runbook steps         : ${state.runbook?.steps?.length ?? 0}`);
  console.log(`Steps executed        : ${state.executor_results.length}`);
  console.log(`Steps validated       : ${state.validator_results.length}`);
  console.log(`Postmortem action items: ${state.postmortem?.action_items?.length ?? 0}`);
  console.log(`Timeline events       : ${state.timeline.length}`);

  if (failed.length > 0) {
    console.log(`\n✗  TEST FAILED — ${failed.length} check(s) did not pass`);
    process.exit(1);
  }
  console.log('\n✓  ALL CHECKS PASSED');
}

main();
