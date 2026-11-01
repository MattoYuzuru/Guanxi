# ADR-0035: Agent browser and site sessions

**Status:** accepted direction (owner decisions D-139, D-140); proposed design · **Date:** 2026-10-20
**Refines:** [ADR-0029](0029-computer-use-tiers.md) tier 1; relates to ADR-0017 (secrets),
ADR-0018 (leases), ADR-0022 (sandbox and egress), ADR-0027 (access modes).

## Context

The owner wants a built-in browser that agents prefer over the user's own: more capable for
agents, visible to the user, restyled as Guanxi, able to use the user's logins. Lane 4 found:
ChatGPT Atlas was shut down on 2026-08-09 and folded into the ChatGPT desktop app; the closest
open-source product, BrowserOS neo, is AGPL (process-only for Guanxi); Chrome increasingly
blocks copying sessions (App-Bound Encryption since 127, remote debugging ignored on the default
profile since 136, device-bound Google sessions since 146); Electron is not meant for untrusted
web content and its native views cannot float under HTML or survive a closed window; Chrome's
December 2025 agentic-security design is the strongest published model.

## Decision

1. **Scope:** the agents' browser plus product preview, not a daily browser (D-139).
   D-229 clarifies that this is a general agent browser for ordinary sites and localhost
   under the run policy; pilot sites are coverage choices, not a product whitelist. Explore
   explicit Chrome/Firefox session handoff while preserving the consent/secret boundaries
   below. No covert cookie, password or passkey-store extraction is approved.
2. **Engine in the node service:** a `browser-host` component runs Chromium through
   `playwright-core` (Apache-2.0). Clients (desktop, web, phone) show it as a streamed pane that
   can be docked, floated and popped out; the user can watch, take over and hand back. A "pop out
   to a real window" path covers passkeys and OS-bound flows. The Electron shell never exposes its
   own remote-debugging endpoint.
3. **Profiles and contexts:** an ephemeral context per run (default), an optional persistent
   personal profile per account, and an opt-in live-Chrome connection; each is a governor lease
   (`browser-context`, `browser-profile`, `browser-live`). Persistent profiles use real at-rest
   encryption (Playwright's default basic password store is overridden).
4. **Site sessions (D-140):**
   - log in inside the Guanxi browser (default; passwords filled from a password manager by
     `secret://` reference);
   - **Guanxi Bridge** extension in the user's Chromium browser: per-site host permission
     requested at runtime, plus a Guanxi grant screen; shares that site's cookies once, on run
     start, or live; revocable in one click;
   - delegated control of the live Chrome (Bridge-driven tab group or Chrome's own consented
     connection) for device-bound or SSO sites;
   - bookmarks and history imported from files.
   Never: bulk cookie import, reading browser secret stores in core, bypassing App-Bound
   Encryption, or an agent installing the extension or granting itself sites. An optional
   "import assistant" agent may plan an import from typed steps; deterministic code executes it
   after the user approves the per-site checklist.
5. **Storage:** session bundles live encrypted in the account vault on opted-in owner devices;
   never on cloud nodes by default; never in model context, logs, traces or exports (the egress
   scrubber gains cookie rules). Site grants (domain, source, sync mode, scopes, access, expiry,
   last use) are visible metadata on Connections → Browser.
6. **Security model:** per-run readable and writable origin sets; adding an origin only through
   the run policy or a clean link on a readable page; model-generated URLs carrying data are
   refused; Read-only mode makes every origin read-only (no typing, submitting, uploading or
   downloading); contexts load cookies only for granted sites; page text enters context as
   labelled untrusted content; hidden text is flagged; downloads go to a per-run quarantine;
   network goes through the egress proxy; no approval prompts unless the project's
   `requires_confirmation` list names an action class (D-118, D-122); captcha, 2FA and passkeys
   raise `input_required` for takeover.
7. **Agent tools** (MCP-shaped): open, snapshot (accessibility refs), act, navigate, extract,
   network and console listings, downloads, `fill_secret`, `request_takeover`, and WebMCP calls
   where sites offer them. External agents get a per-run scoped endpoint, never the whole browser.
8. **Not adopted:** BrowserOS neo and Lightpanda may be added later as optional external
   connections only (AGPL).

## Invariants

- No cookie value, password or one-time code appears in a prompt, tool result, snapshot sent to a
  remote model, log, trace or handoff.
- A run's context holds sessions only for sites granted to that run's project and role.
- Revoking a grant closes contexts that use it within one lease TTL.
- A Read-only run cannot submit a form.

## Consequences

Agents get a deterministic, observable browser with session evidence and human takeover; users
keep control of which sites agents act on. Costs: a Chrome extension to maintain (unpacked first, Chrome
Web Store before MS2, D-178), screencast quality to tune, and sites whose terms forbid automation.

## Validation

Injection pages (hidden text, OCR text, crafted URL) cause no out-of-scope action; a planted
cookie value never appears in events, logs or model requests; a Read-only run's form submission is
blocked (explicit assertion); revocation closes a live context within one TTL.

## Evidence

[04 agent browser and layout](../research/2026-10-20-design/04-agent-browser-and-layout.md)
§§2–5; Chrome agentic-security design (2025-12); Chromium App-Bound Encryption and
remote-debugging changes; Playwright documentation.
