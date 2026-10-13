export const RISK_MODEL_VERSION = 'fixed-signal-v1'
export const RISK_BASELINE = 0.2

// A transparent assumption-based score, not a measured failure frequency.
// Unknown results add no evidence; successful tool calls only reduce earlier error pressure.
export function nextRiskScore(score, outcome) {
  const current = Number.isFinite(score) ? Math.max(0, Math.min(3, score)) : 0
  if (outcome === 'error') return Math.min(3, current + 1)
  if (outcome === 'success') return Math.max(0, current - 0.25)
  return current
}

export function riskEstimate(score) {
  const bounded = Number.isFinite(score) ? Math.max(0, Math.min(3, score)) : 0
  const odds = (RISK_BASELINE / (1 - RISK_BASELINE)) * Math.pow(3, bounded)
  return {
    status: 'assumption_based_uncalibrated',
    value: odds / (1 + odds),
    baseline: RISK_BASELINE,
    score: bounded,
    modelVersion: RISK_MODEL_VERSION,
  }
}
