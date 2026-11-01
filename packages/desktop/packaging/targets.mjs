// The one place that says which CPU the macOS package is built for. The electron-builder configuration targets
// it, and the service staging (which installs host-specific native prebuilds and a host-specific Node.js)
// refuses to run on any other.
export const MAC_ARCH = 'arm64'
// Permanent identity approved by the owner in D-224, before the first signed release.
export const DESKTOP_APP_ID = 'io.github.mattoyuzuru.guanxi'
