import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  blocked: boolean;
  blocked_reason?: string;
}

// Patterns that are never allowed regardless of approval.
// These are catastrophic, irreversible commands that no runbook should generate.
const HARD_BLOCKED: RegExp[] = [
  /\brm\s+(-[rRf]{1,3}\s+)+\//,        // rm -rf /... (destructive filesystem wipe)
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, // DELETE without WHERE clause
  /\btruncate\s+table\b/i,
  /kubectl\s+delete\s+(namespace|node|pv)\b/i, // cluster-level deletes
  /\bformat\s+\/dev\//i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
];

export async function executeCommand(
  command: string,
  timeoutSeconds: number
): Promise<CommandResult> {
  for (const pattern of HARD_BLOCKED) {
    if (pattern.test(command)) {
      return {
        stdout: '',
        stderr: '',
        exit_code: 1,
        duration_ms: 0,
        blocked: true,
        blocked_reason: `Safety filter blocked command matching: ${pattern.source}`,
      };
    }
  }

  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutSeconds * 1000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 500),
      exit_code: 0,
      duration_ms: Date.now() - start,
      blocked: false,
    };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
    return {
      stdout: (e.stdout ?? '').slice(0, 2000),
      stderr: (e.stderr ?? e.message).slice(0, 500),
      exit_code: typeof e.code === 'number' ? e.code : 1,
      duration_ms: Date.now() - start,
      blocked: false,
    };
  }
}
