// Runtime bridge to upstream Cordis core. Types for exactly the surface Guanxi
// uses live in cordis-runtime.d.ts: the published Cordis declarations use
// extensionless relative re-exports that NodeNext type resolution cannot follow.
export { Context, CordisError, Fiber, RegistryService, Service } from 'cordis'
