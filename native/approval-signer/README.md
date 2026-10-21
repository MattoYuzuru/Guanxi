# Approval signing helper

`approval-signer` signs Guanxi catalog approvals and change requests with an owner key that
lives in the Secure Enclave. One invocation handles one request: a JSON object on stdin, a JSON
object on stdout. Exit codes are 0 (success), 1 (refused or failed request) and 2 (usage error).
Diagnostics go to stderr and never contain key material.

The protocol, the production build and the test build are documented in
[`docs/plans/lanes/DS2.handoff.md`](../../docs/plans/lanes/DS2.handoff.md) and in the
[design record](../../docs/design/COMPONENTS_AND_CATALOG.md#41-review-record-format-stable-ds2-signs-it).
The production binary is installed by `packages/server/scripts/install-approval-signer.ts`.
