import Anthropic from '@anthropic-ai/sdk';
import { TRIAGE_PROMPT } from '../prompts/triage';
import { ROOT_CAUSE_PROMPT } from '../prompts/rootCause';
import { COMMS_PROMPT } from '../prompts/comms';
import { RUNBOOK_PROMPT } from '../prompts/runbook';
import { EXECUTOR_PROMPT } from '../prompts/executor';
import { VALIDATOR_PROMPT } from '../prompts/validator';
import { POSTMORTEM_PROMPT } from '../prompts/postmortem';
import type { AgentLog } from '../types/incident';
import { logger } from './logger';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Per-agent call timeout — prevents a hung API call from blocking the pipeline indefinitely
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10); // 5 min default

export type AgentRole =
  | 'triage'
  | 'rootCause'
  | 'comms'
  | 'runbook'
  | 'executor'
  | 'validator'
  | 'postmortem';

const PROMPTS: Record<AgentRole, string> = {
  triage:     TRIAGE_PROMPT,
  rootCause:  ROOT_CAUSE_PROMPT,
  comms:      COMMS_PROMPT,
  runbook:    RUNBOOK_PROMPT,
  executor:   EXECUTOR_PROMPT,
  validator:  VALIDATOR_PROMPT,
  postmortem: POSTMORTEM_PROMPT,
};

// Sonnet for deep reasoning, Haiku for speed-critical roles
const MODEL_MAP: Record<AgentRole, string> = {
  triage:     'claude-haiku-4-5',
  rootCause:  'claude-sonnet-4-6',
  comms:      'claude-haiku-4-5',
  runbook:    'claude-sonnet-4-6',
  executor:   'claude-haiku-4-5',
  validator:  'claude-haiku-4-5',
  postmortem: 'claude-sonnet-4-6',
};

export async function callAgent<T>(
  role: AgentRole,
  payload: object,
  incidentId: string
): Promise<T> {
  const model = MODEL_MAP[role];
  const systemPrompt = PROMPTS[role];
  const start = Date.now();

  let raw: string;
  let inputTokens = 0;
  let outputTokens = 0;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      },
      { signal: controller.signal }
    );
    clearTimeout(timeoutHandle);
    const block = response.content[0];
    raw = block && block.type === 'text' ? block.text : '';
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  } catch (err) {
    clearTimeout(timeoutHandle);
    const msg = (err as Error).message;
    throw new Error(`[${role}] API call failed: ${msg}`);
  }

  const log: AgentLog = {
    incident_id: incidentId,
    agent_role: role,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
  logger.info('Agent call complete', { incident_id: incidentId, role, model, input_tokens: inputTokens, output_tokens: outputTokens, duration_ms: log.duration_ms });

  try {
    const { saveAgentLog } = await import('./incidentStore');
    await saveAgentLog(log);
  } catch (e) {
    logger.error('Failed to persist agent log', { role, error: (e as Error).message });
  }

  // Strip prose before/after JSON
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`[${role}] No JSON in response: ${raw.slice(0, 300)}`);
  }
  const cleaned = raw.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // One retry with explicit correction
    const retryController = new AbortController();
    const retryTimeout = setTimeout(() => retryController.abort(), AGENT_TIMEOUT_MS);
    try {
      const retry = await anthropic.messages.create(
        {
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [
            { role: 'user', content: JSON.stringify(payload) },
            { role: 'assistant', content: raw },
            { role: 'user', content: 'Return only valid JSON. No other text.' },
          ],
        },
        { signal: retryController.signal }
      );
      clearTimeout(retryTimeout);
      const retryBlock = retry.content[0];
      const r = retryBlock && retryBlock.type === 'text' ? retryBlock.text : '';
      const rs = r.indexOf('{');
      const re = r.lastIndexOf('}');
      if (rs === -1) throw new Error(`[${role}] Retry failed to produce JSON`);
      return JSON.parse(r.slice(rs, re + 1)) as T;
    } finally {
      clearTimeout(retryTimeout);
    }
  }
}
