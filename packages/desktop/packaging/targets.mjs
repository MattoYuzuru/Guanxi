// The one place that says which CPU the macOS package is built for. The electron-builder configuration targets
// it, and the service staging (which installs host-specific native prebuilds and a host-specific Node.js)
// refuses to run on any other.
export const MAC_ARCH = 'arm64'
