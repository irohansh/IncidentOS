import { describe, it, expect } from 'vitest';
import { assertSafeUrl } from '../../lib/metricsClient';

describe('assertSafeUrl SSRF guard', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://metadata.google.internal',
    'http://100.100.100.200/latest/meta-data',
    'http://0.0.0.0:9090',
    'http://[::1]:9090',
    'file:///etc/passwd',
    'gopher://internal:70',
    'ftp://internal/file',
  ];

  it.each(blocked)('rejects %s', (url) => {
    expect(() => assertSafeUrl(url, 'PROMETHEUS_URL')).toThrow();
  });

  const allowed = [
    'https://prometheus.internal',
    'http://prometheus.monitoring.svc.cluster.local:9090',
    'https://grafana.example.com/',
  ];

  it.each(allowed)('accepts %s', (url) => {
    expect(() => assertSafeUrl(url, 'PROMETHEUS_URL')).not.toThrow();
  });

  it('rejects a subdomain of a blocked metadata host', () => {
    expect(() => assertSafeUrl('http://foo.metadata.google.internal', 'GRAFANA_URL')).toThrow();
  });
});
