/**
 * Allowlist-based command policy (Appendix C).
 * Returns { allowed, reason, argv, binary, riskFloor } or throws if the
 * command string cannot even be tokenized safely.
 */

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface PolicyResult {
  allowed: true;
  argv: string[];
  binary: string;
  riskFloor: RiskLevel;
}

export interface PolicyDenial {
  allowed: false;
  reason: string;
}

// Fixed map: logical tool name → absolute binary path.
// Adding a new tool requires a code change here — never dynamic resolution.
export const BINARY_MAP: Record<string, string> = {
  kubectl:   '/usr/local/bin/kubectl',
  psql:      '/usr/bin/psql',
  'redis-cli': '/usr/bin/redis-cli',
  docker:    '/usr/bin/docker',
};

// Chars that are meaningful to the shell and must never appear unquoted outside a string.
const SHELL_METACHAR = /[;&|<>$`(){}*?~!\\\n\r\0]/;

// Resource name: lowercase alphanumeric, dot, dash — max 253 chars (k8s DNS subdomain limit).
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9.\-]{0,252}$/;

// Service/deployment name (stricter: no dots).
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Flags that change identity, target cluster, or certificate trust.
const IDENTITY_FLAGS = new Set([
  '--kubeconfig', '--token', '--as', '--as-group',
  '--server', '--certificate-authority', '--insecure-skip-tls-verify',
  '-f', '--filename',
]);

function deny(reason: string): PolicyDenial {
  return { allowed: false, reason };
}

/**
 * Tokenize a command string into argv.
 * Supports: single-quoted and double-quoted strings (no escaping inside single quotes;
 * only \" \\ inside double quotes). Everything else is a bare word.
 * Rejects shell metacharacters outside quotes.
 */
export function tokenize(cmd: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  let current = '';

  while (i < cmd.length) {
    const ch = cmd[i];

    if (ch === "'") {
      // Single-quoted string — no escape sequences; terminates at next single quote.
      i++;
      const end = cmd.indexOf("'", i);
      if (end === -1) return null; // unclosed quote
      current += cmd.slice(i, end);
      i = end + 1;
    } else if (ch === '"') {
      // Double-quoted string — only \" and \\ are escapes.
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
          current += cmd[i + 1];
          i += 2;
        } else {
          // Reject shell metacharacters even inside double quotes (conservative).
          if (SHELL_METACHAR.test(cmd[i])) return null;
          current += cmd[i];
          i++;
        }
      }
      if (i >= cmd.length) return null; // unclosed double quote
      i++; // skip closing "
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) { tokens.push(current); current = ''; }
      i++;
    } else {
      if (SHELL_METACHAR.test(ch)) return null;
      current += ch;
      i++;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens.length > 0 ? tokens : null;
}

function isIdentityFlag(arg: string): boolean {
  const base = arg.split('=')[0];
  return IDENTITY_FLAGS.has(base);
}

function allowedNamespaces(): string[] {
  return (process.env.ALLOWED_K8S_NAMESPACES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── kubectl policy ────────────────────────────────────────────────────────────

const KUBECTL_READ_VERBS = new Set(['get', 'describe', 'logs', 'top']);
const KUBECTL_ROLLOUT_SUBVERBS = new Set(['status', 'history', 'undo', 'restart']);
const KUBECTL_FORBIDDEN_VERBS = new Set([
  'exec', 'cp', 'proxy', 'port-forward', 'apply', 'patch', 'edit',
  'replace', 'run', 'attach', 'debug', 'drain', 'cordon',
]);

function checkKubectl(argv: string[]): PolicyResult | PolicyDenial {
  const verb = argv[1];
  if (!verb) return deny('kubectl: missing verb');

  if (KUBECTL_FORBIDDEN_VERBS.has(verb)) {
    return deny(`kubectl: verb "${verb}" is not allowed`);
  }

  // Check for identity flags anywhere in the argv.
  for (const arg of argv.slice(1)) {
    if (isIdentityFlag(arg)) return deny(`kubectl: flag "${arg.split('=')[0]}" is not allowed`);
    // Block -A / --all-namespaces for any mutating or potentially dangerous verbs.
    if (arg === '-A' || arg === '--all-namespaces') {
      if (!KUBECTL_READ_VERBS.has(verb)) return deny('kubectl: --all-namespaces not allowed for non-read verbs');
    }
  }

  // Resolve -n / --namespace and validate it.
  let namespace: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-n' || argv[i] === '--namespace') {
      namespace = argv[i + 1];
      break;
    }
    if (argv[i].startsWith('--namespace=')) {
      namespace = argv[i].slice('--namespace='.length);
      break;
    }
    if (argv[i].startsWith('-n=')) {
      namespace = argv[i].slice(3);
      break;
    }
  }

  const allowed = allowedNamespaces();
  if (namespace) {
    if (allowed.length > 0 && !allowed.includes(namespace)) {
      return deny(`kubectl: namespace "${namespace}" is not in ALLOWED_K8S_NAMESPACES`);
    }
  } else if (
    !KUBECTL_READ_VERBS.has(verb) &&
    verb !== 'rollout' &&
    verb !== 'scale' &&
    verb !== 'delete'
  ) {
    return deny(`kubectl: -n <namespace> is required for verb "${verb}"`);
  }

  if (KUBECTL_READ_VERBS.has(verb)) {
    return { allowed: true, argv, binary: BINARY_MAP.kubectl, riskFloor: 'safe' };
  }

  if (verb === 'rollout') {
    const subverb = argv[2];
    if (!subverb || !KUBECTL_ROLLOUT_SUBVERBS.has(subverb)) {
      return deny(`kubectl: rollout subverb "${subverb}" is not allowed`);
    }
    const riskFloor: RiskLevel = subverb === 'undo' || subverb === 'restart' ? 'high' : 'safe';
    return { allowed: true, argv, binary: BINARY_MAP.kubectl, riskFloor };
  }

  if (verb === 'scale') {
    // kubectl scale deployment <name> --replicas=N -n <ns>
    if (argv[2] !== 'deployment') return deny('kubectl: scale only allowed on deployment');
    const replFlag = argv.find((a) => a.startsWith('--replicas='));
    if (!replFlag) return deny('kubectl: scale requires --replicas=N');
    const n = parseInt(replFlag.split('=')[1], 10);
    const maxReplicas = parseInt(process.env.MAX_SCALE_REPLICAS ?? '50', 10);
    if (isNaN(n) || n < 0 || n > maxReplicas) {
      return deny(`kubectl: replicas must be 0–${maxReplicas}, got ${replFlag.split('=')[1]}`);
    }
    const name = argv[3];
    if (!name || !SERVICE_NAME_RE.test(name)) return deny(`kubectl: invalid deployment name "${name}"`);
    if (!namespace) return deny('kubectl: scale requires -n <namespace>');
    return { allowed: true, argv, binary: BINARY_MAP.kubectl, riskFloor: 'high' };
  }

  if (verb === 'delete') {
    // Only: kubectl delete pod <name> -n <ns>   (single pod, -n required, no --all/selector)
    const resource = argv[2];
    if (resource !== 'pod') return deny(`kubectl: delete is only allowed for pods`);
    const name = argv[3];
    if (!name || !RESOURCE_NAME_RE.test(name)) return deny(`kubectl: invalid pod name "${name}"`);
    if (!namespace) return deny('kubectl: delete pod requires -n <namespace>');
    if (argv.some((a) => a === '--all' || a.startsWith('-l') || a.startsWith('--selector'))) {
      return deny('kubectl: delete with --all/selector not allowed');
    }
    return { allowed: true, argv, binary: BINARY_MAP.kubectl, riskFloor: 'high' };
  }

  return deny(`kubectl: verb "${verb}" is not in the allowlist`);
}

// ── psql policy ───────────────────────────────────────────────────────────────

function checkPsql(argv: string[]): PolicyResult | PolicyDenial {
  // Connection comes from env, never from command args.
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-h') || arg.startsWith('--host') ||
        arg.startsWith('-U') || arg.startsWith('--username') ||
        arg.startsWith('-d') || arg.startsWith('--dbname') ||
        arg === '-f' || arg === '--file') {
      return deny(`psql: connection override flag "${arg}" is not allowed — connection comes from env`);
    }
  }

  // Must have exactly: psql -c "<single statement>"
  const cIdx = argv.indexOf('-c');
  if (cIdx === -1) return deny('psql: must use -c "<statement>"');
  const stmt = argv[cIdx + 1];
  if (!stmt) return deny('psql: -c requires a statement');

  // No semicolons (multiple statements).
  if (stmt.includes(';')) return deny('psql: multiple statements (;) not allowed');

  // Forbidden DML/DDL patterns.
  const forbidden = [
    /\bCOPY\b/i, /\\copy/i, /\bDROP\b/i, /\bTRUNCATE\b/i,
    /\bALTER\b/i, /\bGRANT\b/i, /\bCREATE\b/i,
    /\bDELETE\b(?!.*\bWHERE\b)/i, /\bUPDATE\b(?!.*\bWHERE\b)/i,
  ];
  for (const re of forbidden) {
    if (re.test(stmt)) return deny(`psql: forbidden SQL pattern in statement`);
  }

  return { allowed: true, argv, binary: BINARY_MAP.psql, riskFloor: 'safe' };
}

// ── redis-cli policy ──────────────────────────────────────────────────────────

const REDIS_ALLOWED = new Set(['PING', 'INFO', 'DBSIZE', 'SLOWLOG', 'CLIENT', 'MEMORY']);
const REDIS_FORBIDDEN = new Set([
  'FLUSHALL', 'FLUSHDB', 'CONFIG', 'DEBUG', 'EVAL', 'SCRIPT', 'SHUTDOWN', 'KEYS',
]);

function checkRedisCli(argv: string[]): PolicyResult | PolicyDenial {
  const cmd = argv[1]?.toUpperCase();
  if (!cmd) return deny('redis-cli: missing command');
  if (REDIS_FORBIDDEN.has(cmd)) return deny(`redis-cli: command "${cmd}" is not allowed`);
  if (!REDIS_ALLOWED.has(cmd)) return deny(`redis-cli: command "${cmd}" is not in the allowlist`);
  return { allowed: true, argv, binary: BINARY_MAP['redis-cli'], riskFloor: 'safe' };
}

// ── docker policy ─────────────────────────────────────────────────────────────

const DOCKER_ALLOWED = new Set(['ps', 'logs', 'inspect', 'restart']);
const DOCKER_FORBIDDEN = new Set(['run', 'exec', 'rm', 'build']);

function checkDocker(argv: string[]): PolicyResult | PolicyDenial {
  const cmd = argv[1];
  if (!cmd) return deny('docker: missing command');
  if (DOCKER_FORBIDDEN.has(cmd)) return deny(`docker: command "${cmd}" is not allowed`);
  if (!DOCKER_ALLOWED.has(cmd)) return deny(`docker: command "${cmd}" is not in the allowlist`);
  // Reject -v / --privileged / --volume
  for (const arg of argv.slice(2)) {
    if (arg === '-v' || arg === '--volume' || arg === '--privileged' || arg === '-f') {
      return deny(`docker: flag "${arg}" is not allowed`);
    }
  }
  const riskFloor: RiskLevel = cmd === 'restart' ? 'high' : 'safe';
  return { allowed: true, argv, binary: BINARY_MAP.docker, riskFloor };
}

// ── bash policy ───────────────────────────────────────────────────────────────

function checkBash(argv: string[]): PolicyResult | PolicyDenial {
  if (process.env.ALLOW_BASH !== 'true') {
    return deny('bash/sh: ALLOW_BASH is not enabled');
  }
  return deny('bash/sh: not allowed even with ALLOW_BASH (use specific tools instead)');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function evaluateCommand(cmdString: string): PolicyResult | PolicyDenial {
  if (!cmdString || cmdString.length > 2048) {
    return deny('Command is empty or exceeds 2048 characters');
  }

  // Must be a single line of printable ASCII.
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmdString)) {
    return deny('Command contains control characters');
  }
  if (/\n|\r/.test(cmdString)) {
    return deny('Command must be a single line');
  }

  const argv = tokenize(cmdString);
  if (!argv) {
    return deny('Command contains shell metacharacters or unclosed quotes');
  }

  const tool = argv[0];
  if (!tool || !BINARY_MAP[tool]) {
    const allowedTools = Object.keys(BINARY_MAP).join(', ');
    return deny(`Tool "${tool}" is not in the allowlist (allowed: ${allowedTools})`);
  }

  if (tool === 'bash' || tool === 'sh') return checkBash(argv);
  if (tool === 'kubectl')               return checkKubectl(argv);
  if (tool === 'psql')                  return checkPsql(argv);
  if (tool === 'redis-cli')             return checkRedisCli(argv);
  if (tool === 'docker')                return checkDocker(argv);

  return deny(`Tool "${tool}" has no policy handler`);
}
