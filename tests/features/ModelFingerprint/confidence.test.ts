import { describe, expect, it } from "vitest"

import { confidencePercent } from "~/features/ModelFingerprint/confidence"

describe("fingerprint confidence", () => {
  it("shows calibrated closed-set probability as a percentage", () => {
    expect(
      confidencePercent(
        { probability_status: "reference_calibrated", used_outputs: 3 },
        0.998,
      ),
    ).toBe(99.8)
    expect(
      confidencePercent(
        { probability_status: "reference_calibrated", used_outputs: 3 },
        0,
      ),
    ).toBe(0)
  })
  it("never substitutes raw ranking scores when one sample failed", () => {
    expect(
      confidencePercent(
        { probability_status: "unavailable", used_outputs: 2 },
        null,
      ),
    ).toBeNull()
    expect(
      confidencePercent(
        { probability_status: "reference_calibrated", used_outputs: 2 },
        0.99,
      ),
    ).toBeNull()
    expect(
      confidencePercent({ probability_status: "unavailable" }, 3.681),
    ).toBeNull()
  })
  it("rejects malformed probabilities and absent calibration", () => {
    for (const value of [undefined, null, NaN, Infinity, -0.1, 1.1])
      expect(
        confidencePercent(
          { probability_status: "reference_calibrated" },
          value,
        ),
      ).toBeNull()
    expect(confidencePercent({}, 0.9)).toBeNull()
  })
})
