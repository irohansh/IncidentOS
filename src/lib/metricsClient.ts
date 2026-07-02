import type { MetricsSnapshot } from '../types/incident';

// Fetch current metrics from Prometheus. Returns zeroed snapshot if PROMETHEUS_URL is not set.
export async function fetchMetrics(services: string[]): Promise<MetricsSnapshot> {
  const base = process.env.PROMETHEUS_URL;
  if (!base) {
    return {
      fetched_at: new Date().toISOString(),
      error_rate_5m: 0,
      p99_latency_ms: 0,
      request_rate: 0,
      cpu_usage_percent: 0,
      memory_usage_percent: 0,
      pod_restart_count: 0,
      db_connection_pool_usage: 0,
      custom: {},
    };
  }

  const serviceFilter = services.map(s => `service="${s}"`).join('|');
  const queries: Record<string, string> = {
    error_rate_5m: `sum(rate(http_requests_total{${serviceFilter},status=~"5.."}[5m])) / sum(rate(http_requests_total{${serviceFilter}}[5m]))`,
    p99_latency_ms: `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{${serviceFilter}}[5m])) by (le)) * 1000`,
    request_rate: `sum(rate(http_requests_total{${serviceFilter}}[5m]))`,
    cpu_usage_percent: `avg(rate(container_cpu_usage_seconds_total{${serviceFilter}}[5m])) * 100`,
    memory_usage_percent: `avg(container_memory_usage_bytes{${serviceFilter}}) / avg(container_spec_memory_limit_bytes{${serviceFilter}}) * 100`,
    pod_restart_count: `sum(kube_pod_container_status_restarts_total{${serviceFilter}})`,
    db_connection_pool_usage: `avg(db_connection_pool_used{${serviceFilter}}) / avg(db_connection_pool_max{${serviceFilter}})`,
  };

  const snapshot: MetricsSnapshot = {
    fetched_at: new Date().toISOString(),
    custom: {},
  };

  await Promise.allSettled(
    Object.entries(queries).map(async ([key, query]) => {
      try {
        const url = `${base}/api/v1/query?query=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const json = await res.json() as { data: { result: { value: [number, string] }[] } };
        const val = json.data?.result?.[0]?.value?.[1];
        if (val !== undefined) {
          (snapshot as unknown as Record<string, unknown>)[key] = parseFloat(val);
        }
      } catch {
        // silently skip unavailable metrics
      }
    })
  );

  return snapshot;
}
