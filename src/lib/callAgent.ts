import Anthropic from '@anthropic-ai/sdk';
import { TRIAGE_PROMPT } from '../prompts/triage';
import { ROOT_CAUSE_PROMPT } from '../prompts/rootCause';
import { COMMS_PROMPT } from '../prompts/comms';
import { RUNBOOK_PROMPT } from '../prompts/runbook';
import { EXECUTOR_PROMPT } from '../prompts/executor';
import { VALIDATOR_PROMPT } from '../prompts/validator';
import { POSTMORTEM_PROMPT } from '../prompts/postmortem';
import { AGENT_SCHEMAS } from '../types/schemas';
import type { AgentLog } from '../types/incident';
import { logger } from './logger';
import { UNTRUSTED_PREAMBLE } from './untrusted';

// P3.2: Set maxRetries explicitly; SDK will retry 429/529/5xx/network errors
// with exponential backoff.  Default is 2; operator can raise via env.
const SDK_MAX_RETRIES = parseInt(process.env.AGENT_API_MAX_RETRIES ?? '2', 10);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: SDK_MAX_RETRIES,
});

const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10);

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

const MODEL_MAP: Record<AgentRole, string> = {
  triage:     process.env.MODEL_TRIAGE     ?? 'claude-haiku-4-5',
  rootCause:  process.env.MODEL_ROOT_CAUSE ?? 'claude-sonnet-4-6',
  comms:      process.env.MODEL_COMMS      ?? 'claude-haiku-4-5',
  runbook:    process.env.MODEL_RUNBOOK    ?? 'claude-sonnet-4-6',
  executor:   process.env.MODEL_EXECUTOR   ?? 'claude-haiku-4-5',
  validator:  process.env.MODEL_VALIDATOR  ?? 'claude-haiku-4-5',
  postmortem: process.env.MODEL_POSTMORTEM ?? 'claude-sonnet-4-6',
};

function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + 1);
}

function fixRequiresApproval<T>(role: AgentRole, parsed: T): T {
  if (role !== 'runbook') return parsed;
  const obj = parsed as Record<string, unknown>;
  const steps = obj.steps as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(steps)) return parsed;
  obj.steps = steps.map((step) => {
    const risk = step.risk_level as string;
    if (['medium', 'high', 'critical'].includes(risk) && !step.requires_approval) {
      return { ...step, requires_approval: true };
    }
    return step;
  });
  return parsed;
}

export async function callAgent<T>(
  role: AgentRole,
  payload: object,
  incidentId: string
): Promise<T> {
  const model = MODEL_MAP[role];
  const fullSystemPrompt = `${UNTRUSTED_PREAMBLE}\n\n${PROMPTS[role]}`;
  const start = Date.now();

  let raw = '';
  let inputTokens = 0;
  let outputTokens = 0;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: 8192,
        system: fullSystemPrompt,
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
    throw new Error(`[${role}] API call failed: ${(err as Error).message}`);
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
  logger.info('Agent call complete', {
    incident_id: incidentId, role, model,
    input_tokens: inputTokens, output_tokens: outputTokens, duration_ms: log.duration_ms,
  });

  try {
    const { saveAgentLog } = await import('./incidentStore');
    await saveAgentLog(log);
  } catch (e) {
    logger.error('Failed to persist agent log', { role, error: (e as Error).message });
  }

  // P3.1: Parse + validate with Zod; one repair retry on failure.
  return parseAndValidate<T>(role, raw, payload, fullSystemPrompt, model, incidentId);
}

async function parseAndValidate<T>(
  role: AgentRole,
  raw: string,
  originalPayload: object,
  systemPrompt: string,
  model: string,
  incidentId: string,
  isRetry = false
): Promise<T> {
  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    if (isRetry) throw new Error(`[${role}] Retry produced no JSON`);
    return repairAndRetry<T>(role, raw, originalPayload, systemPrompt, model, incidentId, 'Response contained no JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    if (isRetry) throw new Error(`[${role}] Retry produced invalid JSON`);
    return repairAndRetry<T>(role, raw, originalPayload, systemPrompt, model, incidentId, 'Response contained invalid JSON');
  }

  const schema = AGENT_SCHEMAS[role];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const zodError = result.error.toString().slice(0, 800);
    logger.warn('Agent output failed schema validation', { role, incidentId, zodError });
    if (isRetry) throw new Error(`[${role}] Schema validation failed after repair: ${zodError}`);
    return repairAndRetry<T>(role, raw, originalPayload, systemPrompt, model, incidentId, `Schema errors:\n${zodError}`);
  }

  return fixRequiresApproval<T>(role, result.data as T);
}

async function repairAndRetry<T>(
  role: AgentRole,
  previousRaw: string,
  originalPayload: object,
  systemPrompt: string,
  model: string,
  incidentId: string,
  errorDescription: string
): Promise<T> {
  logger.info('Attempting schema repair retry', { role, incidentId, errorDescription });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  let retryRaw = '';
  try {
    const retry = await anthropic.messages.create(
      {
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          { role: 'user', content: JSON.stringify(originalPayload) },
          { role: 'assistant', content: previousRaw },
          {
            role: 'user',
            content: `Your previous response had the following issues:\n\n${errorDescription}\n\nReturn only valid JSON that fixes these issues. No prose, no markdown.`,
          },
        ],
      },
      { signal: controller.signal }
    );
    clearTimeout(timeoutHandle);
    const block = retry.content[0];
    retryRaw = block && block.type === 'text' ? block.text : '';
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw new Error(`[${role}] Repair retry API call failed: ${(err as Error).message}`);
  }

  return parseAndValidate<T>(role, retryRaw, originalPayload, systemPrompt, model, incidentId, true);
}
