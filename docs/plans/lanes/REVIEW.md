# Cross-family lane review

**Status:** ready · **Updated:** 2026-10-20 · **Ports:** `GUANXI_WEB_PORT=5190`,
`GUANXI_API_PORT=4390`

Use a model of a different family from the lane's author: GPT reviews Claude lanes (K1,
DS1-b), and Claude reviews GPT and DeepSeek lanes (DS1-a, DS1-c). The integrator fills in the
two placeholders and pastes everything below the line into a read-only session in the lane's
worktree.

---

You are an independent reviewer for Guanxi lane `<LANE>` on branch `<BRANCH>`. Do not edit,
commit, push or merge anything.

Read:

- `AGENTS.md` (Definition of done);
- `docs/plans/lanes/README.md`;
- `docs/plans/lanes/<LANE>.md` (scope, owned paths, exit gate);
- `docs/plans/lanes/<LANE>.handoff.md`.

Then review `git diff main...<BRANCH>`.

Report findings ranked by severity: Critical, High, Medium, Low. Give each one a file:line,
the concrete failure scenario, and the smallest fix. Check:

1. **Exit gate.** Every exit-gate item has an assertion that would fail if the property broke.
   Try to name an input that breaks the property while the tests stay green.
2. **Correctness and data.** Correctness, concurrency, cancellation and data integrity.
   SQLite migrations are append-only.
3. **Security.**
   - No secret values or reasoning in code, tests, fixtures, logs or docs.
   - Approval signing cannot be forged by an agent.
   - The server stays loopback by default.
4. **Ownership and licensing.**
   - Edits outside the lane's owned paths are listed as shared edits.
   - Every copied third-party file has a `THIRD_PARTY_NOTICES.md` entry and an allowed
     licence (ADR-0016).
5. **Tests.** No weakened or deleted tests, no hidden caps, no `proposed` work described as
   implemented.

You may run read-only commands. Heavy checks (`npm test`, the browser gate, the build) go
through the shared lock:

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm test
```

End with a verdict: merge, merge after fixes, or do not merge.
