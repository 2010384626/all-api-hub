import type { DetectionResult } from "./types"

/** Raw ranking scores are not probabilities; only calibrated results get percentages. */
export function confidencePercent(
  analysis: DetectionResult["analysis"],
  probability: number | null | undefined,
): number | null {
  if (
    analysis?.probability_status !== "reference_calibrated" ||
    (analysis.used_outputs !== undefined && analysis.used_outputs !== 3) ||
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    return null
  return probability * 100
}
