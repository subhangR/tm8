/**
 * Dependency-free descriptive statistics for the perf rigs.
 *
 * Deliberately boring: every number a gate quotes must be reproducible by hand
 * from the raw samples the rig also emits. No smoothing, no outlier removal —
 * a perf claim that needs an outlier filter to pass is not a parity claim.
 */

/** Nearest-rank percentile (p in [0,100]). Returns null for an empty sample. */
export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function mean(samples) {
  if (!samples.length) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function stddev(samples) {
  if (samples.length < 2) return null;
  const m = mean(samples);
  const v = samples.reduce((acc, x) => acc + (x - m) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(v);
}

/** The summary block every perf artifact carries. `null` fields = no samples. */
export function summarize(samples) {
  return {
    n: samples.length,
    min: samples.length ? Math.min(...samples) : null,
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length ? Math.max(...samples) : null,
    mean: mean(samples),
    stddev: stddev(samples),
  };
}

/** Bucket counts for a fixed set of upper edges, plus an overflow bucket. */
export function histogram(samples, edges) {
  const buckets = edges.map((edge) => ({ ltMs: edge, count: 0 }));
  let overflow = 0;
  for (const s of samples) {
    const idx = edges.findIndex((edge) => s < edge);
    if (idx === -1) overflow++;
    else buckets[idx].count++;
  }
  return { buckets, overflow };
}

export function round(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Round every numeric leaf of a summary/histogram for readable JSON artifacts. */
export function roundDeep(value, digits = 2) {
  if (typeof value === 'number') return round(value, digits);
  if (Array.isArray(value)) return value.map((v) => roundDeep(v, digits));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v, digits)]));
  }
  return value;
}
