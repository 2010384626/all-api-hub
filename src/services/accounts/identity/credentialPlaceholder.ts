/** Recognize exported redaction markers without rejecting ordinary short credentials. */
export function isRedactedCredential(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:<redacted>|\[redacted\]|\[已脱敏\]|\*{3,}|•{3,})$/i.test(value.trim())
  )
}
