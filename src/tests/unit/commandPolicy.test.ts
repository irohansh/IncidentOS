import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluateCommand, tokenize } from '../../lib/commandPolicy';

describe('commandPolicy — tokenizer', () => {
  it('splits plain args', () => {
    expect(tokenize('kubectl get pods')).toEqual(['kubectl', 'get', 'pods']);
  });

  it('handles single-quoted strings', () => {
    expect(tokenize("psql -c 'SELECT 1'")).toEqual(['psql', '-c', 'SELECT 1']);
  });

  it('handles double-quoted strings', () => {
    expect(tokenize('kubectl get pods -n "prod"')).toEqual(['kubectl', 'get', 'pods', '-n', 'prod']);
  });

  it('returns null for unclosed single quote', () => {
    expect(tokenize("kubectl get 'pods")).toBeNull();
  });

  it('returns null for unclosed double quote', () => {
    expect(tokenize('kubectl get "pods')).toBeNull();
  });

  it('returns null for shell metacharacter ;', () => {
    expect(tokenize('kubectl get pods; id')).toBeNull();
  });

  it('returns null for shell metacharacter &&', () => {
    expect(tokenize('kubectl get pods && id')).toBeNull();
  });

  it('returns null for shell metacharacter |', () => {
    expect(tokenize('kubectl get pods | sh')).toBeNull();
  });

  it('returns null for NUL byte', () => {
    expect(tokenize('kubectl get\x00pods')).toBeNull();
  });

  it('returns null for $() substitution', () => {
    expect(tokenize('kubectl get $(id)')).toBeNull();
  });

  it('returns null for backtick', () => {
    expect(tokenize('kubectl `id`')).toBeNull();
  });
});

describe('commandPolicy — evaluateCommand rejections', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.ALLOWED_K8S_NAMESPACES = 'prod,payments';
    process.env.EXECUTION_MODE = 'dry_run';
  });
  afterEach(() => { process.env = { ...OLD }; });

  const shouldReject: [string, string][] = [
    ['kubectl get pods; id',                  'shell injection ;'],
    ['kubectl get pods && id',                'shell injection &&'],
    ['kubectl get pods || id',                'shell injection ||'],
    ['kubectl get pods | sh',                 'pipe to sh'],
    ['kubectl get\npods',                     'newline in command'],
    ['kubectl get\x00pods',                   'NUL in command'],
    ['kubectl get pods\r',                    'CR in command'],
    ['kubectl get $(id)',                      'command substitution'],
    ['kubectl `whoami`',                      'backtick execution'],
    ['kubectl get ${IFS}',                    'env variable interpolation'],
    ['kubectl get $HOME/pods',               'env variable in path'],
    ['kubectl get pods -n prod --kubeconfig=x', 'kubeconfig override'],
    ['kubectl get pods -n prod --token=abc',  'token override'],
    ['kubectl get pods -n prod --as=root',    'impersonation'],
    ['kubectl exec pod/foo -- bash',          'exec is forbidden'],
    ['kubectl cp foo:/tmp/x /tmp/y',          'cp is forbidden'],
    ['kubectl proxy',                         'proxy is forbidden'],
    ['kubectl get pods -n staging',           'namespace not in allowlist'],
    ['bash -c "id"',                          'bash not allowed'],
    ['sh -c id',                              'sh not allowed'],
    ['docker run alpine sh',                  'docker run not allowed'],
    ['docker exec abc bash',                  'docker exec not allowed'],
    ['redis-cli FLUSHALL',                    'FLUSHALL forbidden'],
    ['redis-cli FLUSHDB',                     'FLUSHDB forbidden'],
    ['redis-cli CONFIG SET maxmemory 1gb',    'CONFIG forbidden'],
    ['redis-cli KEYS *',                      'KEYS forbidden'],
  ];

  it.each(shouldReject)('rejects: %s (%s)', (cmd) => {
    const result = evaluateCommand(cmd);
    expect(result.allowed, `expected "${cmd}" to be rejected`).toBe(false);
  });
});

describe('commandPolicy — evaluateCommand allowances', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.ALLOWED_K8S_NAMESPACES = 'prod,payments';
    process.env.EXECUTION_MODE = 'dry_run';
  });
  afterEach(() => { process.env = { ...OLD }; });

  const shouldAllow: [string, string][] = [
    ['kubectl get pods -n prod',               'kubectl get in allowed ns'],
    ['kubectl rollout undo deploy/checkout-api -n prod', 'kubectl rollout undo'],
    ['kubectl rollout status deploy/checkout -n prod',   'kubectl rollout status'],
    ['kubectl logs deploy/x -n prod --tail=200',         'kubectl logs'],
    ['kubectl scale deployment checkout --replicas=3 -n payments', 'kubectl scale'],
    ['kubectl describe pod abc -n prod',       'kubectl describe'],
    ['kubectl delete pod checkout-abc123 -n prod', 'kubectl delete single pod'],
    ['redis-cli PING',                         'redis-cli PING'],
    ['redis-cli INFO',                         'redis-cli INFO'],
    ['redis-cli DBSIZE',                       'redis-cli DBSIZE'],
    ['docker ps',                              'docker ps'],
    ['docker logs my-container',               'docker logs'],
    ['docker inspect my-container',            'docker inspect'],
  ];

  it.each(shouldAllow)('allows: %s (%s)', (cmd) => {
    const result = evaluateCommand(cmd);
    expect(result.allowed, `expected "${cmd}" to be allowed but got: ${!result.allowed && (result as { reason: string }).reason}`).toBe(true);
  });
});
