/** Operator entry for the MS1 live pairing: `node packages/server/scripts/ms1-live/ms1-live.ts <command>`.
 * The commands and their exit codes are in src/ms1-live/cli.ts and docs/operations/ms1-live-run.md. */
import { main } from '../../src/ms1-live/cli.ts'

const code = await main(process.argv.slice(2))
process.exit(code)
