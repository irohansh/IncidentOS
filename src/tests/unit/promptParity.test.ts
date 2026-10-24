import { describe, it, expect } from 'vitest';
import { TRIAGE_INPUT_FIELDS } from '../../agents/triage';
import { ROOT_CAUSE_INPUT_FIELDS } from '../../agents/rootCause';

// S13: Verify that every field declared in TRIAGE_INPUT_FIELDS / ROOT_CAUSE_INPUT_FIELDS
// is actually sent in the agent payload (and vice-versa).  If a field is added to the
// prompt without being wired into the payload object, this test fails.

describe('Prompt/payload parity (S13)', () => {
  it('triage payload keys match declared input fields', () => {
    // The payload built in runTriage:
    const payloadKeys = ['alert', 'metrics', 'recent_incidents'];
    expect([...TRIAGE_INPUT_FIELDS].sort()).toEqual([...payloadKeys].sort());
  });

  it('rootCause payload keys match declared input fields', () => {
    // The payload built in runRootCause:
    const payloadKeys = [
      'incident',
      'recent_deploys',
      'metrics_history',
      'correlated_alerts',
      'runbook_hints',
    ];
    expect([...ROOT_CAUSE_INPUT_FIELDS].sort()).toEqual([...payloadKeys].sort());
  });
});
