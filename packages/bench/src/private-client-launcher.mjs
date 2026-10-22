#!/usr/bin/env node
/** Trusted boundary launcher: close lifetime/control fds before the fixture client imports. */
import { closeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

for (const fd of [5, 6]) {
  try { closeSync(fd) } catch { /* not inherited */ }
}
await import(pathToFileURL(process.argv[2]).href)
