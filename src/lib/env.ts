export interface EnvViolation {
  name: string;
  reason: 'missing' | 'placeholder' | 'insecure_in_production';
}

const PLACEHOLDERS = new Set(['CHANGE_ME', '__GENERATE__', '']);

function isPlaceholder(val: string): boolean {
  return PLACEHOLDERS.has(val);
}

export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const violations: EnvViolation[] = [];

  // Core required variables — always.
  for (const name of ['ANTHROPIC_API_KEY', 'DATABASE_URL']) {
    const val = process.env[name];
    if (!val) {
      violations.push({ name, reason: 'missing' });
    } else if (isProd && isPlaceholder(val)) {
      violations.push({ name, reason: 'placeholder' });
    }
  }

  // Dangerous flags that must never be true in production.
  if (isProd) {
    const dangerousFlags: Record<string, string> = {
      TEST_AUTO_APPROVE:    'true',
      ALLOW_INSECURE_DEV:   'true',
    };
    for (const [name, badValue] of Object.entries(dangerousFlags)) {
      if (process.env[name] === badValue) {
        violations.push({ name, reason: 'insecure_in_production' });
      }
    }
    if (process.env.LLM_MODE === 'mock') {
      violations.push({ name: 'LLM_MODE', reason: 'insecure_in_production' });
    }
    if (
      process.env.EXECUTION_MODE === 'simulated' &&
      process.env.ALLOW_SIMULATED_IN_PROD !== 'true'
    ) {
      violations.push({ name: 'EXECUTION_MODE', reason: 'insecure_in_production' });
    }
  }

  if (violations.length > 0) {
    const lines = violations.map((v) => `  ${v.name}: ${v.reason}`).join('\n');
    throw new Error(`Environment configuration error:\n${lines}`);
  }

  // Validate URL-typed vars are actually URLs.
  const urlVars = ['DATABASE_URL', 'PROMETHEUS_URL', 'GRAFANA_URL'];
  for (const key of urlVars) {
    const val = process.env[key];
    if (!val) continue;
    try {
      new URL(val);
    } catch {
      throw new Error(`Environment variable ${key} is not a valid URL: ${val}`);
    }
  }

  // GITHUB_ISSUES_REPO / GITHUB_REPO must be owner/repo format.
  for (const key of ['GITHUB_REPO', 'GITHUB_ISSUES_REPO']) {
    const repo = process.env[key];
    if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
      throw new Error(`${key} must be in "owner/repo" format, got: ${repo}`);
    }
  }
}
