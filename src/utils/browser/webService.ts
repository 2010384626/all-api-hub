/** Set by the authenticated VPS page before loading the shared application. */
export function isWebService() {
  return (globalThis as { __AAH_WEB__?: boolean }).__AAH_WEB__ === true
}
