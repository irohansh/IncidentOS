import type { AlertPayload } from '../../types/incident';

export const sampleAlert: AlertPayload = {
  incident_id: 'INC-2024-001',
  title: 'P0: checkout-service error rate exceeded 90% — orders failing',
  alert_source: 'pagerduty',
  severity_hint: 'critical',
  affected_services: ['checkout-service', 'payment-gateway', 'order-service'],
  metric_name: 'http_request_error_rate_5m',
  metric_value: 0.94,
  threshold: 0.05,
  started_at: new Date().toISOString(),
  links: [
    { href: 'https://grafana.internal/d/checkout', text: 'Checkout Dashboard' },
    { href: 'https://pagerduty.com/incidents/INC-2024-001', text: 'PagerDuty Incident' },
  ],
  raw: {
    pagerduty_event_type: 'trigger',
    service_name: 'checkout-service',
    dedup_key: 'checkout-error-rate-2024-001',
    client: 'prometheus',
    labels: {
      alertname: 'CheckoutErrorRateHigh',
      env: 'production',
      namespace: 'production',
      pod: 'checkout-service-7d6b9c-xkp2m',
    },
    annotations: {
      summary: 'Checkout service error rate is 94% (threshold: 5%)',
      description: 'The checkout service has been returning errors for 94% of requests over the last 5 minutes. This indicates a complete service outage affecting all purchase attempts.',
      runbook_url: 'https://wiki.internal/runbooks/checkout-outage',
    },
  },
};
