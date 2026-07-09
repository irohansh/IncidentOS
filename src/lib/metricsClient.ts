import type { MetricsSnapshot } from '../types/incident';

// Fetch current metrics from Prometheus. Returns zeroed snapshot if PROMETHEUS_URL is not set.
export async function fetchMetrics(services: string[]): Promise<MetricsSnapshot> {
  const base = process.env.PROMETHEUS_URL;

  const snapshot: MetricsSnapshot = {
    fetched_at: new Date().toISOString(),
    custom: {},
  };

  if (!base) {
    snapshot.error_rate_5m = 0;
    snapshot.p99_latency_ms = 0;
    snapshot.request_rate = 0;
    snapshot.cpu_usage_percent = 0;
    snapshot.memory_usage_percent = 0;
    snapshot.pod_restart_count = 0;
    snapshot.db_connection_pool_usage = 0;
  } else {
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
  }

  // Grafana: active alerts + recent annotations (runs regardless of Prometheus)
  const grafana = await fetchGrafanaData();
  if (grafana.activeAlerts > 0) snapshot.grafana_active_alerts = grafana.activeAlerts;
  if (grafana.annotations.length > 0) snapshot.grafana_annotations = grafana.annotations;

  return snapshot;
}

interface GrafanaData {
  activeAlerts: number;
  annotations: string[];
}

async function fetchGrafanaData(): Promise<GrafanaData> {
  const base = process.env.GRAFANA_URL;
  if (!base) return { activeAlerts: 0, annotations: [] };

  const apiKey = process.env.GRAFANA_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let activeAlerts = 0;
  const annotations: string[] = [];

  // Try unified alerting (Grafana 8+)
  try {
    const res = await fetch(`${base}/api/alertmanager/grafana/api/v2/alerts`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const alerts = await res.json() as Array<{
        status?: { state?: string };
        labels?: Record<string, string>;
        startsAt?: string;
      }>;
      const firing = alerts.filter(
        a => a.status?.state === 'active' || a.status?.state === 'firing'
      );
      activeAlerts = firing.length;
      firing.forEach(a => {
        annotations.push(
          `[Grafana Alert] ${a.labels?.alertname ?? 'unknown'} firing since ${a.startsAt ?? 'unknown'}`
        );
      });
    }
  } catch {
    // Fall back to legacy alerting API
    try {
      const res = await fetch(`${base}/api/alerts?state=alerting`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const alerts = await res.json() as Array<{
          name?: string;
          newStateDate?: string;
        }>;
        activeAlerts = alerts.length;
        alerts.forEach(a => {
          annotations.push(`[Grafana Alert] ${a.name ?? 'unknown'} since ${a.newStateDate ?? 'unknown'}`);
        });
      }
    } catch {
      console.log('[metricsClient] Grafana not reachable at', base);
    }
  }

  // Recent annotations (deployment markers, manual events) from the last 2 hours
  try {
    const from = Date.now() - 2 * 60 * 60 * 1000;
    const to = Date.now();
    const res = await fetch(`${base}/api/annotations?from=${from}&to=${to}&limit=20`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const annots = await res.json() as Array<{
        text?: string;
        time?: number;
        tags?: string[];
      }>;
      annots
        .filter(a => a.text || (a.tags && a.tags.length > 0))
        .forEach(a => {
          const ts = a.time ? new Date(a.time).toISOString() : 'unknown';
          const label = a.text ?? a.tags?.join(', ') ?? '';
          annotations.push(`[Grafana Annotation] ${ts}: ${label}`);
        });
    }
  } catch {
    // skip if annotations endpoint fails
  }

  return { activeAlerts, annotations };
}
