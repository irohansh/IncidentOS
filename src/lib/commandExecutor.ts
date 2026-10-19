import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';
import { evaluateCommand, BINARY_MAP } from './commandPolicy';

// Kept as defense-in-depth: catches catastrophic patterns before the policy runs.
const HARD_BLOCKED: { pattern: RegExp | ((cmd: string) => boolean); reason: string }[] = [
  { pattern: /\brm\s+(-[rRf]{1,3}\s+)*-?[rRf]*f[rR]?\s+\/(?!\S)/,       reason: 'rm targeting root filesystem' },
  { pattern: /\brm\s+(-[rRf]+\s+)+\/[a-z]/i,                               reason: 'rm -rf targeting system directory' },
  { pattern: /\bformat\s+\/dev\//i,                                         reason: 'disk format command' },
  { pattern: /\bdd\s+if=/i,                                                 reason: 'dd disk-dump command' },
  { pattern: /\bmkfs\b/i,                                                   reason: 'filesystem creation command' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/,                                       reason: 'redirect to raw disk device' },
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|KEYSPACE)\b/i,               reason: 'DROP TABLE/DATABASE' },
  { pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i,                         reason: 'DELETE without WHERE clause' },
  { pattern: /\bTRUNCATE\s+(TABLE\s+)?\w/i,                               reason: 'TRUNCATE command' },
  { pattern: /kubectl\s+delete\s+(namespace|node|pv\b|clusterrole|clusterrolebinding)/i, reason: 'kubectl cluster-level delete' },
  { pattern: /\$\([^)]+\)/,                                                reason: 'shell command substitution $()' },
  { pattern: (cmd) => cmd.includes('`'),                                   reason: 'shell backtick command execution' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba?sh|sh|python[23]?|perl|ruby|node)\b/i, reason: 'download-and-execute pipe' },
  { pattern: /\bchmod\s+[ugoa]*[+= ]*[sx]\b/i,                           reason: 'chmod setuid/setgid' },
  { pattern: /\bchown\s+root[:./]/i,                                       reason: 'chown to root' },
  { pattern: /:\s*\(\s*\)\s*\{.*:\s*\|.*:\s*&/,                          reason: 'fork bomb pattern' },
  { pattern: /(?:\btee\b|>>?)\s*\/etc\/(cron|sudoers|passwd|shadow|hosts)/i, reason: 'write to sensitive /etc file' },
];

export function checkBlocked(command: string): { blocked: true; reason: string } | null {
  for (const rule of HARD_BLOCKED) {
    const matched =
      typeof rule.pattern === 'function'
        ? rule.pattern(command)
        : rule.pattern.test(command);
    if (matched) return { blocked: true, reason: rule.reason };
  }
  return null;
}

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  blocked: boolean;
  blocked_reason?: string;
  execution_mode: 'real' | 'dry_run' | 'simulated';
}

// Minimum environment passed to each command — never inherits secrets.
function safeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
  };
}

export async function executeCommand(
  command: string,
  timeoutSeconds: number
): Promise<CommandResult> {
  const executionMode = (process.env.EXECUTION_MODE ?? 'simulated') as 'real' | 'dry_run' | 'simulated';

  // Policy check — always, regardless of mode.
  const policy = evaluateCommand(command);
  if (!policy.allowed) {
    logger.warn('Command blocked by policy', { command: command.slice(0, 200), reason: policy.reason });
    return {
      stdout: '',
      stderr: policy.reason,
      exit_code: 1,
      duration_ms: 0,
      blocked: true,
      blocked_reason: policy.reason,
      execution_mode: executionMode,
    };
  }

  if (executionMode === 'simulated') {
    logger.info('Simulated command (not executed)', { command: command.slice(0, 200) });
    return {
      stdout: '[simulated] Command would have run: ' + command,
      stderr: '',
      exit_code: 0,
      duration_ms: 0,
      blocked: false,
      execution_mode: 'simulated',
    };
  }

  if (executionMode === 'dry_run') {
    // For kubectl, add --dry-run=server where the verb supports it.
    let dryRunArgv = policy.argv;
    if (policy.binary === BINARY_MAP.kubectl) {
      const verb = dryRunArgv[1];
      const dryRunVerbs = new Set(['delete', 'scale', 'rollout']);
      if (verb && dryRunVerbs.has(verb) && !dryRunArgv.includes('--dry-run=server')) {
        dryRunArgv = [...dryRunArgv, '--dry-run=client'];
      }
    }
    logger.info('Dry-run command (policy-checked, not executed on real resources)', {
      command: command.slice(0, 200),
    });
    return {
      stdout: `[dry_run] Would execute: ${policy.binary} ${dryRunArgv.slice(1).join(' ')}`,
      stderr: '',
      exit_code: 0,
      duration_ms: 0,
      blocked: false,
      execution_mode: 'dry_run',
    };
  }

  // Real execution — spawn without shell, least-privilege env, output cap.
  logger.info('Executing approved command', {
    binary: policy.binary,
    argv: policy.argv.join(' ').slice(0, 200),
    timeoutSeconds,
  });

  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(policy.binary, policy.argv.slice(1), {
      timeout: timeoutSeconds * 1000,
      maxBuffer: 2 * 1024 * 1024,
      env: safeEnv(),
      shell: false,
    });
    const duration_ms = Date.now() - start;
    logger.info('Command completed', { exit_code: 0, duration_ms });
    return {
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 1000),
      exit_code: 0,
      duration_ms,
      blocked: false,
      execution_mode: 'real',
    };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
    const duration_ms = Date.now() - start;
    const exit_code = typeof e.code === 'number' ? e.code : 1;
    logger.warn('Command failed', {
      exit_code,
      duration_ms,
      stderr: (e.stderr ?? e.message).slice(0, 200),
    });
    return {
      stdout: (e.stdout ?? '').slice(0, 4000),
      stderr: (e.stderr ?? e.message).slice(0, 1000),
      exit_code,
      duration_ms,
      blocked: false,
      execution_mode: 'real',
    };
  }
}
