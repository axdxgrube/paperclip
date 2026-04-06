type TrackedApiRouteKey =
  | "health"
  | "issues.checkout"
  | "issues.update"
  | "issues.comment"
  | "agents.me.inbox_lite";

type TrackedApiRoute = {
  key: TrackedApiRouteKey;
  description: string;
  method: "GET" | "POST" | "PATCH";
  pathTemplate: string;
  pathPattern: RegExp;
  warnP95Ms: number;
  criticalP95Ms: number;
  warnErrorRatePct: number;
  criticalErrorRatePct: number;
};

type LatencySample = {
  durationMs: number;
  statusCode: number;
  observedAt: string;
};

const MAX_SAMPLES_PER_ROUTE = 500;
const MIN_SAMPLES_FOR_ALERTING = 20;

const TRACKED_API_ROUTES: TrackedApiRoute[] = [
  {
    key: "health",
    description: "API health check",
    method: "GET",
    pathTemplate: "/api/health",
    pathPattern: /^\/api\/health\/?$/i,
    warnP95Ms: 120,
    criticalP95Ms: 250,
    warnErrorRatePct: 1,
    criticalErrorRatePct: 5,
  },
  {
    key: "issues.checkout",
    description: "Issue checkout",
    method: "POST",
    pathTemplate: "/api/issues/:id/checkout",
    pathPattern: /^\/api\/issues\/[^/]+\/checkout\/?$/i,
    warnP95Ms: 300,
    criticalP95Ms: 600,
    warnErrorRatePct: 2,
    criticalErrorRatePct: 8,
  },
  {
    key: "issues.update",
    description: "Issue update",
    method: "PATCH",
    pathTemplate: "/api/issues/:id",
    pathPattern: /^\/api\/issues\/[^/]+\/?$/i,
    warnP95Ms: 300,
    criticalP95Ms: 600,
    warnErrorRatePct: 2,
    criticalErrorRatePct: 8,
  },
  {
    key: "issues.comment",
    description: "Issue comment create",
    method: "POST",
    pathTemplate: "/api/issues/:id/comments",
    pathPattern: /^\/api\/issues\/[^/]+\/comments\/?$/i,
    warnP95Ms: 350,
    criticalP95Ms: 700,
    warnErrorRatePct: 2,
    criticalErrorRatePct: 8,
  },
  {
    key: "agents.me.inbox_lite",
    description: "Agent inbox-lite fetch",
    method: "GET",
    pathTemplate: "/api/agents/me/inbox-lite",
    pathPattern: /^\/api\/agents\/me\/inbox-lite\/?$/i,
    warnP95Ms: 250,
    criticalP95Ms: 500,
    warnErrorRatePct: 2,
    criticalErrorRatePct: 8,
  },
];

const samplesByRoute = new Map<TrackedApiRouteKey, LatencySample[]>(
  TRACKED_API_ROUTES.map((route) => [route.key, []]),
);

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sortedValues: number[], pct: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const clamped = Math.max(0, Math.min(100, pct));
  const rank = (clamped / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sortedValues[lower] ?? sortedValues[0] ?? 0;
  const upperValue = sortedValues[upper] ?? sortedValues[sortedValues.length - 1] ?? lowerValue;
  const fraction = rank - lower;
  return lowerValue + (upperValue - lowerValue) * fraction;
}

function findTrackedRoute(method: string, path: string): TrackedApiRoute | null {
  const normalizedMethod = method.toUpperCase();
  for (const route of TRACKED_API_ROUTES) {
    if (route.method !== normalizedMethod) continue;
    if (!route.pathPattern.test(path)) continue;
    return route;
  }
  return null;
}

export function recordApiLatencySample(input: {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  observedAt?: Date;
}) {
  const route = findTrackedRoute(input.method, input.path);
  if (!route) return null;
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return route.key;

  const samples = samplesByRoute.get(route.key);
  if (!samples) return route.key;

  const observedAt = input.observedAt ?? new Date();
  samples.push({
    durationMs: input.durationMs,
    statusCode: input.statusCode,
    observedAt: observedAt.toISOString(),
  });
  if (samples.length > MAX_SAMPLES_PER_ROUTE) {
    samples.splice(0, samples.length - MAX_SAMPLES_PER_ROUTE);
  }
  return route.key;
}

function deriveAlert(
  route: TrackedApiRoute,
  sampleCount: number,
  p95Ms: number | null,
  errorRatePct: number | null,
) {
  if (sampleCount < MIN_SAMPLES_FOR_ALERTING) {
    return {
      status: "insufficient_data" as const,
      reason: `Need at least ${MIN_SAMPLES_FOR_ALERTING} samples per route for actionable alerts.`,
      escalation:
        "Collect additional traffic. If latency concerns are urgent, run an on-demand benchmark and post results on the issue.",
    };
  }

  const highP95 = p95Ms ?? 0;
  const highErrorRate = errorRatePct ?? 0;
  if (highP95 >= route.criticalP95Ms || highErrorRate >= route.criticalErrorRatePct) {
    return {
      status: "critical" as const,
      reason: "Critical latency/error threshold exceeded.",
      escalation:
        "Escalate immediately to CTO/on-call owner, assign remediation work, and post updates until the route recovers.",
    };
  }
  if (highP95 >= route.warnP95Ms || highErrorRate >= route.warnErrorRatePct) {
    return {
      status: "warning" as const,
      reason: "Warning latency/error threshold exceeded.",
      escalation:
        "Create or update a follow-up issue for optimization and monitor this route in the next heartbeats.",
    };
  }
  return {
    status: "ok" as const,
    reason: "Latency and error rate are within target thresholds.",
    escalation: "No action required.",
  };
}

export function getApiLatencySummary() {
  const routes = TRACKED_API_ROUTES.map((route) => {
    const samples = samplesByRoute.get(route.key) ?? [];
    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const sampleCount = durations.length;
    const lastSampleAt = samples[samples.length - 1]?.observedAt ?? null;
    const p50 = sampleCount ? percentile(durations, 50) : null;
    const p95 = sampleCount ? percentile(durations, 95) : null;
    const p99 = sampleCount ? percentile(durations, 99) : null;
    const min = sampleCount ? durations[0] ?? null : null;
    const max = sampleCount ? durations[sampleCount - 1] ?? null : null;
    const avg =
      sampleCount > 0
        ? durations.reduce((sum, value) => sum + value, 0) / sampleCount
        : null;
    const serverErrors = samples.filter((sample) => sample.statusCode >= 500).length;
    const errorRatePct = sampleCount > 0 ? (serverErrors / sampleCount) * 100 : null;
    const alert = deriveAlert(route, sampleCount, p95, errorRatePct);

    return {
      key: route.key,
      description: route.description,
      method: route.method,
      pathTemplate: route.pathTemplate,
      sampleCount,
      latencyMs: sampleCount
        ? {
            p50: roundToTwo(p50 ?? 0),
            p95: roundToTwo(p95 ?? 0),
            p99: roundToTwo(p99 ?? 0),
            avg: roundToTwo(avg ?? 0),
            min: roundToTwo(min ?? 0),
            max: roundToTwo(max ?? 0),
          }
        : null,
      errorRatePct: errorRatePct == null ? null : roundToTwo(errorRatePct),
      lastSampleAt,
      thresholds: {
        warnP95Ms: route.warnP95Ms,
        criticalP95Ms: route.criticalP95Ms,
        warnErrorRatePct: route.warnErrorRatePct,
        criticalErrorRatePct: route.criticalErrorRatePct,
      },
      alert,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    retention: {
      maxSamplesPerRoute: MAX_SAMPLES_PER_ROUTE,
      minSamplesForAlerting: MIN_SAMPLES_FOR_ALERTING,
      storage: "in_memory_process_lifetime",
    },
    routes,
  };
}

export function resetApiLatencySamplesForTests() {
  for (const samples of samplesByRoute.values()) {
    samples.splice(0, samples.length);
  }
}
