/**
 * Redacts secrets from strings before they reach logs, Slack, DB result columns,
 * or LLM prompts.
 */

const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9\-_]{10,}/g,
  // GitHub tokens
  /ghp_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{82,}/g,
  // Slack bot tokens
  /xox[bprs]-[0-9A-Za-z\-]{10,}/g,
  // Bearer tokens in Authorization headers
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Postgres/DB connection strings with credentials
  /postgresql?:\/\/[^:]+:[^@\s]+@/g,
  /mysql:\/\/[^:]+:[^@\s]+@/g,
  // Generic secrets in URL auth
  /:[A-Za-z0-9\-._~!$&'()*+,;=%]{8,}@/g,
];

export function redact(text: string): string {
  let result = text;
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

export function redactObject(obj: unknown): unknown {
  if (typeof obj === 'string') return redact(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = redactObject(v);
    }
    return out;
  }
  return obj;
}
