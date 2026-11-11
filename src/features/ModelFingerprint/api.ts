/** Same-origin authenticated API for fingerprint actions and persisted records. */
export async function fingerprintRequest<T>(
  route: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const base = new URL("./", window.location.href)
  const headers: Record<string, string> = {}
  if (options.method && options.method !== "GET") {
    const sessionResponse = await fetch(new URL("api/session", base), {
      credentials: "same-origin",
      signal: options.signal,
    })
    const session = await sessionResponse.json()
    if (!session.authenticated || !session.csrfToken)
      throw new Error("Session expired. Please sign in again.")
    headers["x-csrf-token"] = session.csrfToken
    headers["content-type"] = "application/json"
  }
  const response = await fetch(new URL(`api/${route}`, base), {
    method: options.method,
    signal: options.signal,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const data = await response.json()
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `HTTP ${response.status}`,
    )
  return data as T
}
