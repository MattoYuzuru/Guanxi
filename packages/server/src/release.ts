/**
 * Whether this code runs from a bundled release build. The server and CLI build scripts set
 * `__GUANXI_RELEASE_BUILD__` with an esbuild `define`; running from source leaves it undefined.
 * Release builds never write component approvals (D-138).
 */
declare const __GUANXI_RELEASE_BUILD__: boolean | undefined

export const RELEASE_BUILD =
  typeof __GUANXI_RELEASE_BUILD__ !== 'undefined' && __GUANXI_RELEASE_BUILD__ === true
