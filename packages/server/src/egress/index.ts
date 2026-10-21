export * from './types.ts'
// The SecretScrubber class stays internal: every consumer uses the kernel
// service, so there is one registry per node.
export { formsOf } from './scrubber.ts'
export { egressScrubberPlugin } from './plugin.ts'
