import { describe, it, expect, vi } from 'vitest';
import { isRetryable, runWithRetry } from '../../lib/db';

const noSleep = () => Promise.resolve();

function connTimeout(): Error {
  return new Error('Connection terminated due to connection timeout');
}

describe('isRetryable', () => {
  const retryable = [
    new Error('Connection terminated due to connection timeout'),
    new Error('Connection terminated unexpectedly'),
    new Error('timeout exceeded when trying to connect'),
    new Error('read ECONNRESET'),
    new Error('Client has encountered a connection error and is not queryable'),
    Object.assign(new Error('admin shutdown'), { code: '57P01' }),
    Object.assign(new Error('connection failure'), { code: '08006' }),
  ];
  it.each(retryable)('treats "%s" as retryable', (err) => {
    expect(isRetryable(err)).toBe(true);
  });

  const notRetryable = [
    Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    Object.assign(new Error('null value in column violates not-null constraint'), { code: '23502' }),
    new Error('syntax error at or near "SELCT"'),
  ];
  it.each(notRetryable)('treats "%s" as NOT retryable', (err) => {
    expect(isRetryable(err)).toBe(false);
  });
});

describe('runWithRetry', () => {
  it('returns immediately when the op succeeds first try', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(runWithRetry(op, noSleep)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection and succeeds on a later attempt', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(connTimeout())
      .mockRejectedValueOnce(connTimeout())
      .mockResolvedValue('ok');
    await expect(runWithRetry(op, noSleep)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-connection error', async () => {
    const op = vi.fn().mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' })
    );
    await expect(runWithRetry(op, noSleep)).rejects.toThrow('duplicate key');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting all attempts (3) and rethrows the last error', async () => {
    const op = vi.fn().mockRejectedValue(connTimeout());
    await expect(runWithRetry(op, noSleep)).rejects.toThrow(/connection timeout/i);
    expect(op).toHaveBeenCalledTimes(3);
  });
});
