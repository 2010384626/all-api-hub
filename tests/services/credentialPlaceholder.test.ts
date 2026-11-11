import { describe, expect, it } from "vitest"

import { isRedactedCredential } from "~/services/accounts/identity/credentialPlaceholder"

describe("credential export placeholders", () => {
  it("recognizes exported placeholders without exposing their value", () => {
    for (const value of [
      "<redacted>",
      " [REDACTED] ",
      "***",
      "••••",
      "[已脱敏]",
    ])
      expect(isRedactedCredential(value)).toBe(true)
  })
  it("preserves real token and Cookie strings", () => {
    for (const value of [
      "abc123",
      "session=abc; clearance=def",
      "sk-actual-key",
      "",
      null,
    ])
      expect(isRedactedCredential(value)).toBe(false)
  })
})
