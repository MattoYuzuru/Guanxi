#!/usr/bin/env node
/** Trusted boundary launcher: the supervisor maps lifetime/control stdio to ignore at spawn. */
import { pathToFileURL } from 'node:url'

// Node may reuse fd 5/6 for its own event loop before JS runs (notably on Linux).
// Closing those numbers here corrupts the runtime; no parent capability was inherited.
await import(pathToFileURL(process.argv[2]).href)
