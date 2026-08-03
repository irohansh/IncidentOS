import type { MetricsSnapshot } from '../types/incident';
import { logger } from './logger';

// Addresses that are only reachable from inside cloud VMs and must never be fetched.
const SSRF_BLOCKED_HOSTS = [
  'metadata.google.internal',
  '169.254.169.254',   // AWS/GCP/Azure instance metadata
  '100.100.100.200',   // Alibaba Cloud metadata
  'fd00:ec2::254',     // AWS IPv6 metadata
  '::1',
  '0.0.0.0',
];

export function assertSafeUrl(raw: string, envKey: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envKey} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${envKey} must use http or https, got: ${url.protocol}`);
  }
  // Strip brackets Node keeps on IPv6 literals so the blocklist matches "[::1]".
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (SSRF_BLOCKED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error(`${envKey} points to a blocked metadata/loopback host: ${hostname}`);
  }
  return url;
}

export async function fetchMetrics(services: string[]): Promise<MetricsSnapshot> {
  const baseRaw = process.env.PROMETHEUS_URL;

  const snapshot: MetricsSnapshot = {
    fetched_at: new Date().toISOString(),
    custom: {},
  };

  if (!baseRaw) {
    snapshot.error_rate_5m = 0;
    snapshot.p99_latency_ms = 0;
    snapshot.request_rate = 0;
    snapshot.cpu_usage_percent = 0;
    snapshot.memory_usage_percent = 0;
    snapshot.pod_restart_count = 0;
    snapshot.db_connection_pool_usage = 0;
  } else {
    let base: URL;
    try {
      base = assertSafeUrl(baseRaw, 'PROMETHEUS_URL');
    } catch (err) {
      logger.error('PROMETHEUS_URL rejected', { error: (err as Error).message });
      return snapshot;
    }

    // Sanitize service names: only alphanumeric, dash, underscore, dot
    const safeServices = services
      .map((s) => s.replace(/[^a-zA-Z0-9_\-.]/g, ''))
      .filter(Boolean);
    const serviceFilter = safeServices.map((s) => `service="${s}"`).join('|');

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
          const url = new URL('/api/v1/query', base);
          url.searchParams.set('query', query);
          const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
          const json = (await res.json()) as { data: { result: { value: [number, string] }[] } };
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
  const baseRaw = process.env.GRAFANA_URL;
  if (!baseRaw) return { activeAlerts: 0, annotations: [] };

  let base: URL;
  try {
    base = assertSafeUrl(baseRaw, 'GRAFANA_URL');
  } catch (err) {
    logger.error('GRAFANA_URL rejected', { error: (err as Error).message });
    return { activeAlerts: 0, annotations: [] };
  }

  const apiKey = process.env.GRAFANA_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let activeAlerts = 0;
  const annotations: string[] = [];

  // Try unified alerting (Grafana 8+)
  try {
    const url = new URL('/api/alertmanager/grafana/api/v2/alerts', base);
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const alerts = (await res.json()) as Array<{
        status?: { state?: string };
        labels?: Record<string, string>;
        startsAt?: string;
      }>;
      const firing = alerts.filter((a) => a.status?.state === 'active' || a.status?.state === 'firing');
      activeAlerts = firing.length;
      firing.forEach((a) => {
        annotations.push(
          `[Grafana Alert] ${a.labels?.alertname ?? 'unknown'} firing since ${a.startsAt ?? 'unknown'}`
        );
      });
    }
  } catch {
    // Fall back to legacy alerting API
    try {
      const url = new URL('/api/alerts', base);
      url.searchParams.set('state', 'alerting');
      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const alerts = (await res.json()) as Array<{ name?: string; newStateDate?: string }>;
        activeAlerts = alerts.length;
        alerts.forEach((a) => {
          annotations.push(
            `[Grafana Alert] ${a.name ?? 'unknown'} since ${a.newStateDate ?? 'unknown'}`
          );
        });
      }
    } catch {
      logger.warn('Grafana not reachable', { url: base.host });
    }
  }

  // Recent annotations (last 2 hours)
  try {
    const from = Date.now() - 2 * 60 * 60 * 1000;
    const to = Date.now();
    const url = new URL('/api/annotations', base);
    url.searchParams.set('from', String(from));
    url.searchParams.set('to', String(to));
    url.searchParams.set('limit', '20');
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const annots = (await res.json()) as Array<{ text?: string; time?: number; tags?: string[] }>;
      annots
        .filter((a) => a.text || (a.tags && a.tags.length > 0))
        .forEach((a) => {
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
