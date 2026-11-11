import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { DetectionResultCard } from "~/features/ModelFingerprint/DetectionResultCard"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe("fingerprint result presentation", () => {
  it("shows calibrated percent and all candidates without interpreting ranking scores", () => {
    render(
      <DetectionResultCard
        running={false}
        verifying={false}
        onVerify={vi.fn()}
        result={{
          analysis: {
            probability_status: "reference_calibrated",
            used_outputs: 3,
            probability: 0.998,
            prediction: "top",
            results: Array.from({ length: 9 }, (_, index) => ({
              model: `model-${index}`,
              probability: index ? 0.00025 : 0.998,
              family_name: "GPT",
            })),
          },
        }}
      />,
    )
    expect(screen.getByTestId("fingerprint-top-confidence")).toHaveTextContent(
      "99.8%",
    )
    expect(screen.queryByText("model-8")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "showAll" }))
    expect(screen.getByText("model-8")).toBeInTheDocument()
  })
  it("explains unavailable confidence for partial samples and allows deferred verification", () => {
    const verify = vi.fn()
    const { rerender } = render(
      <DetectionResultCard
        running={false}
        verifying={false}
        onVerify={verify}
        result={{
          analysis: {
            probability_status: "unavailable",
            probability: null,
            results: [{ model: "partial", probability: null }],
          },
        }}
      />,
    )
    expect(screen.getByText("confidenceUnavailable")).toBeInTheDocument()
    expect(screen.getByTestId("fingerprint-top-confidence")).toHaveTextContent(
      "—",
    )
    rerender(
      <DetectionResultCard
        running={false}
        verifying={false}
        onVerify={verify}
        result={{
          historyId: "saved",
          verificationPending: true,
          samples: [{ state: "complete", count: 300, text: "1 2 3" }],
        }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "verifySaved" }))
    expect(verify).toHaveBeenCalledOnce()
  })
})
