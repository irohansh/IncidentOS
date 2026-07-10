export function validateEnv(): void {
  const required = ['ANTHROPIC_API_KEY', 'DATABASE_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate URL-typed vars are actually URLs
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

  // GITHUB_REPO must be owner/repo format
  const repo = process.env.GITHUB_REPO;
  if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`GITHUB_REPO must be in "owner/repo" format, got: ${repo}`);
  }
}
