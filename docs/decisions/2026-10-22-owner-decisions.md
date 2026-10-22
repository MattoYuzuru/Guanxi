# Owner decisions — 2026-10-22 (Fedora continuation and workstation retirement)

**Status:** accepted · **Date:** 2026-10-22 · **Decision:** D-195
**Extends:** [2026-10-21](2026-10-21-owner-decisions.md).
**Source:** the owner's continuation message in the Guanxi development chat.

| ID | Topic | Decision | Source |
| --- | --- | --- | --- |
| D-195 | Fedora checks and obsolete Agent Workstation | The owner restored `ssh fedora`, authorized needed long checks there, and explicitly authorized stopping/removing the obsolete **Agent Workstation** application if unnecessary or interfering. This supersedes this continuation's earlier local-only restriction for the named Fedora host. Retire the old application deliberately, preserve the SSH/VPN route, models and private state, and continue Guanxi with bounded checks. | owner message 2026-10-22; observed retirement and check evidence linked below |

This is an explicit owner release of the old workstation's resident model, not permission for
ordinary builds to evict another active residency lease. D-191's general residency rule remains.
D-194's dedicated-user/rootless/no-GPU rules for **untrusted benchmark containers** and D-150's
budget remain. Trusted synthetic source-regression tests may exercise Fedora's real sandbox
as the dedicated user in separately bounded units. No other host, paid inference, vendor token
transfer, public listener, owner workspace or GitHub push is added to the current check scope.

The actual old inference backend was llama.cpp, not an active Ollama service. Retiring it
does not implement a Guanxi runtime, authorize silent cloud fallback or earn MS1/B3 evidence.
The accepted Fedora-home and future phone-access product direction remains unchanged.

[Fedora continuation evidence](../plans/evidence/Fedora-2026-10-22.md) records actual stopped
units, preserved access, private backup references, resource repair, checks and remaining work.
