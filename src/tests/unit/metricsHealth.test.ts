import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchMetrics } from '../../lib/metricsClient';

// Minimal fetch stub matching the shapes metricsClient reads.
function makeFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown } | 'throw') {
  return (async (input: string) => {
    const r = handler(String(input));
    if (r === 'throw') throw new Error('ECONNREFUSED');
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body ?? {},
    } as unknown as Response;
  }) as typeof fetch;
}

describe('fetchMetrics integration health (P1.5 — unavailable ≠ zero)', () => {
  const OLD = { ...process.env };
  beforeEach(() => { delete process.env.PROMETHEUS_URL; delete process.env.GRAFANA_URL; delete process.env.GRAFANA_API_KEY; });
  afterEach(() => { process.env = { ...OLD }; });

  it('reports not_configured when no URLs are set (no fabricated zeros)', async () => {
    const snap = await fetchMetrics(['checkout'], makeFetch(() => ({ ok: true, body: {} })));
    expect(snap.integration_health?.prometheus).toBe('not_configured');
    expect(snap.integration_health?.grafana).toBe('not_configured');
    // Crucially: metrics are undefined, NOT 0.
    expect(snap.error_rate_5m).toBeUndefined();
    expect(snap.p99_latency_ms).toBeUndefined();
  });

  it('reports prometheus unavailable when the backend is unreachable', async () => {
    process.env.PROMETHEUS_URL = 'http://prometheus.test:9090';
    const snap = await fetchMetrics(['checkout'], makeFetch(() => 'throw'));
    expect(snap.integration_health?.prometheus).toBe('unavailable');
    expect(snap.integration_health?.metrics_retrieved).toEqual([]);
    expect(snap.error_rate_5m).toBeUndefined();
  });

  it('reports ok and records exactly which metrics were retrieved', async () => {
    process.env.PROMETHEUS_URL = 'http://prometheus.test:9090';
    const snap = await fetchMetrics(['checkout'], makeFetch((url) => {
      // "status" appears only in the error_rate_5m PromQL query; return a value for it only.
      if (url.includes('status')) {
        return { ok: true, body: { data: { result: [{ value: [0, '0.42'] }] } } };
      }
      return { ok: true, body: { data: { result: [] } } };
    }));
    expect(snap.integration_health?.prometheus).toBe('ok');
    expect(snap.error_rate_5m).toBeCloseTo(0.42);
    expect(snap.integration_health?.metrics_retrieved).toContain('error_rate_5m');
    expect(snap.integration_health?.metrics_retrieved).not.toContain('p99_latency_ms');
  });

  it('rejects an SSRF-y PROMETHEUS_URL as unavailable (not a crash)', async () => {
    process.env.PROMETHEUS_URL = 'http://169.254.169.254';
    const snap = await fetchMetrics(['checkout'], makeFetch(() => ({ ok: true, body: {} })));
    expect(snap.integration_health?.prometheus).toBe('unavailable');
    expect(snap.integration_health?.prometheus_detail).toMatch(/blocked/i);
  });

  it('reports grafana unavailable when configured but no endpoint responds', async () => {
    process.env.GRAFANA_URL = 'http://grafana.test:3000';
    const snap = await fetchMetrics([], makeFetch(() => ({ ok: false, status: 404 })));
    expect(snap.integration_health?.grafana).toBe('unavailable');
  });
});
