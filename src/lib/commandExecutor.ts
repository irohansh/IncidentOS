import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  blocked: boolean;
  blocked_reason?: string;
}

// Patterns that are NEVER allowed regardless of human approval.
// These are catastrophic or code-execution-bypass patterns.
const HARD_BLOCKED: { pattern: RegExp | ((cmd: string) => boolean); reason: string }[] = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[rRf]{1,3}\s+)*-?[rRf]*f[rR]?\s+\/(?!\S)/,       reason: 'rm targeting root filesystem' },
  { pattern: /\brm\s+(-[rRf]+\s+)+\/[a-z]/i,                               reason: 'rm -rf targeting system directory' },
  { pattern: /\bformat\s+\/dev\//i,                                         reason: 'disk format command' },
  { pattern: /\bdd\s+if=/i,                                                 reason: 'dd disk-dump command' },
  { pattern: /\bmkfs\b/i,                                                   reason: 'filesystem creation command' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/,                                       reason: 'redirect to raw disk device' },

  // Database destruction
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|KEYSPACE)\b/i,               reason: 'DROP TABLE/DATABASE' },
  { pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i,                         reason: 'DELETE without WHERE clause' },
  { pattern: /\bTRUNCATE\s+(TABLE\s+)?\w/i,                               reason: 'TRUNCATE command' },

  // Kubernetes cluster-level destructive ops
  { pattern: /kubectl\s+delete\s+(namespace|node|pv\b|clusterrole|clusterrolebinding)/i, reason: 'kubectl cluster-level delete' },

  // Shell command substitution / injection — these should never appear in safe runbook commands
  { pattern: /\$\([^)]+\)/,                                                reason: 'shell command substitution $()' },
  { pattern: (cmd) => cmd.includes('`'),                                   reason: 'shell backtick command execution' },

  // Download-and-execute (supply chain attack vector)
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba?sh|sh|python[23]?|perl|ruby|node)\b/i, reason: 'download-and-execute pipe' },

  // Privilege escalation
  { pattern: /\bchmod\s+[ugoa]*[+= ]*[sx]\b/i,                           reason: 'chmod setuid/setgid' },
  { pattern: /\bchown\s+root[:./]/i,                                       reason: 'chown to root' },

  // Fork bomb
  { pattern: /:\s*\(\s*\)\s*\{.*:\s*\|.*:\s*&/,                          reason: 'fork bomb pattern' },

  // Writing to sensitive /etc files (crontab/sudoers/hosts tampering).
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

export async function executeCommand(
  command: string,
  timeoutSeconds: number
): Promise<CommandResult> {
  const block = checkBlocked(command);
  if (block) {
    logger.warn('Command blocked by safety filter', { command: command.slice(0, 200), reason: block.reason });
    return {
      stdout: '',
      stderr: '',
      exit_code: 1,
      duration_ms: 0,
      blocked: true,
      blocked_reason: `Safety filter blocked: ${block.reason}`,
    };
  }

  logger.info('Executing approved command', { command: command.slice(0, 200), timeoutSeconds });

  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutSeconds * 1000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const duration_ms = Date.now() - start;
    logger.info('Command completed', { exit_code: 0, duration_ms });
    return {
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 1000),
      exit_code: 0,
      duration_ms,
      blocked: false,
    };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
    const duration_ms = Date.now() - start;
    const exit_code = typeof e.code === 'number' ? e.code : 1;
    logger.warn('Command failed', { exit_code, duration_ms, stderr: (e.stderr ?? e.message).slice(0, 200) });
    return {
      stdout: (e.stdout ?? '').slice(0, 4000),
      stderr: (e.stderr ?? e.message).slice(0, 1000),
      exit_code,
      duration_ms,
      blocked: false,
    };
  }
}
