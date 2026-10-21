# ADR-0029: Computer use in tiers that do not disturb the user

**Status:** proposed · **Date:** 2026-10-19

## Context

Agents should operate browsers and applications with their own cursor while the user keeps
working on the same machine (REQ-H2), and a verifier role may use computer use (REQ-C1). Lane 5 found
mature options per isolation level and a real prompt-injection threat (up to 60% end-to-end
attack success against computer-use agents).

## Decision

Computer use is a ladder of tiers; the default allows tiers 0–2.

| Tier | Mechanism | Disturbs the user? | Platforms |
| --- | --- | --- | --- |
| 0 | APIs and CLIs instead of UI | no | all |
| 1 | Headless, isolated browser via Playwright MCP or Chrome DevTools MCP (`--headless --isolated`) | no | all |
| 2 | Virtual machine or virtual display: Lume VMs on macOS (at most two macOS VMs per Mac under Apple's license), Docker + Xvfb + noVNC on Linux, Windows Sandbox (Pro+, one instance) | no | per platform |
| 3 | Background accessibility actions with an overlay agent cursor (Cua Driver, MIT; AX/UIA/AT-SPI), per-app grants, kill switch | minimal | macOS, Windows, Linux |
| 4 | The real cursor and keyboard, only under an `input-seat` lease while the user is idle | yes | all |

- Displays, browser profiles, the input seat and VM slots are typed leases in the governor
  (ADR-0018), so two agents never fight over a screen.
- Untrusted page content is treated as data: computer-use agents run without secret values,
  with a domain allowlist; irreversible actions stop for confirmation only if they are on the
  project's `requires_confirmation` list (D-118).
- REQ-H2 ("does not disturb the user") holds for tiers 0–3; tier 4 deliberately uses the real
  input and is allowed only while the user is idle.
- Tiers 3–4 run only on a machine the owner is not using (today the Fedora laptop or the
  Windows PC, D-185), never on the MacBook while the owner works on it, and never use the
  live browser profile (D-162 as amended by ADR-0038 §9). Delegated control of the live Chrome is a per-site browser
  grant under ADR-0035 (D-179), not a computer-use tier.

## Validation

A tier-1 run leaves no visible window; a tier-3 action never moves the system cursor; an
injected instruction on a test page does not cause an out-of-scope action.

## Evidence

Lane 5 §3 ([research](../research/README.md)).
