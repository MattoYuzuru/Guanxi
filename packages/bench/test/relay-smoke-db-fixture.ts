// A home-node database fixture for the read-only reader. The table text is a copy of the server's (the drift test
// compares it with the server's own migration text, so this file cannot silently go stale).
import { DatabaseSync } from 'node:sqlite'
import { canonicalText, sha256Hex } from '../src/relay-smoke-facts.ts'

export const RELAY_TABLES_DDL = `
CREATE TABLE relay_runs (run_id TEXT PRIMARY KEY REFERENCES durable_runs(id), snapshot TEXT NOT NULL);
CREATE TABLE relay_seals (run_id TEXT NOT NULL REFERENCES relay_runs(run_id), cycle INTEGER NOT NULL,
 attempt_id TEXT NOT NULL REFERENCES run_attempts(id), epoch INTEGER NOT NULL, token INTEGER NOT NULL,
 ledger TEXT NOT NULL, handoff TEXT NOT NULL, artifact_hash TEXT NOT NULL, markdown TEXT NOT NULL, bundle BLOB NOT NULL,
 PRIMARY KEY(run_id,cycle));
`
export const RUN_COSTS_DDL = `CREATE TABLE run_costs (
    run_id TEXT NOT NULL REFERENCES durable_runs(id),
    entry_key TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES run_attempts(id),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cost_microunits INTEGER CHECK (cost_microunits >= 0),
    currency TEXT NOT NULL CHECK (currency IN ('USD','EUR','RUB','unknown')),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, entry_key)
  );`

export function seed(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false })
  db.exec(RELAY_TABLES_DDL)
  db.exec(RUN_COSTS_DDL)
  return db
}
export const hashOf = (value: unknown) => sha256Hex(canonicalText(value))
export function insertSeal(db: DatabaseSync, run: string, cycle: number, epoch: number, options: { tamper?: 'ledger' | 'bundle' | 'artifact' | 'corrupt' } = {}): void {
  const ledger = { cycle, state: 'sealed', head: String(cycle).padStart(40, 'a'), items: { I01: 'done', I02: 'open' }, evidence: [{ id: 'g1', item: 'I01', head: String(cycle).padStart(40, 'a'), ok: true, output: 'PRIVATE-GATE-OUTPUT' }] }
  const bundle = new TextEncoder().encode(`bundle-${cycle}`)
  const handoff = { format: 'guanxi.handoff/v1', runId: run, cycle, ledgerHash: hashOf(ledger), bundleHash: sha256Hex(bundle), notes: [], narrative: 'n', degraded: false, ledger: { ref: 'r', strip: 's', head: ledger.head, revision: 'rev' } }
  if (options.tamper === 'ledger') handoff.ledgerHash = sha256Hex('other')
  if (options.tamper === 'bundle') handoff.bundleHash = sha256Hex('other')
  db.prepare('INSERT INTO relay_seals VALUES (?,?,?,?,?,?,?,?,?,?)').run(run, cycle, 'attempt-x', epoch, 1, canonicalText(ledger),
    options.tamper === 'corrupt' ? '{not json' : canonicalText(handoff), options.tamper === 'artifact' ? sha256Hex('other') : hashOf(handoff), 'markdown', bundle)
}
export function insertCost(db: DatabaseSync, run: string, key: string, inputTokens: number, outputTokens = 300): void {
  db.prepare('INSERT INTO run_costs(run_id, entry_key, attempt_id, input_tokens, output_tokens, cost_microunits, currency, observed_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(run, key, 'attempt-x', inputTokens, outputTokens, 0, 'USD', 1)
}
