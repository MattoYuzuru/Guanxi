# ADR-0016: Apache-2.0 licensing and third-party reuse policy

**Status:** accepted (owner decision D-102); implemented locally (`npm run check:licenses`); CI wiring waits for a CI pipeline · **Date:** 2026-10-19

## Context

The owner wants maximum reuse of existing open source, full attribution and a public,
non-commercial project that models can learn from. The previous license was MIT. Later the
project wants iOS and Android clients; the App Store terms are considered incompatible with
GPL/AGPL by the FSF.

## Decision

- Guanxi is licensed under **Apache-2.0** (`LICENSE` is the canonical text from apache.org,
  SHA-256 `cfc7749b…3d30`), with a `NOTICE` file.
- Every vendored or adapted file, snippet, prompt or asset is listed in
  `THIRD_PARTY_NOTICES.md` with origin (repository and commit), license and local path. The
  copied file keeps its original header plus "Modified by Guanxi contributors" when changed.
- **Allowed to copy and to depend on:** MIT, MIT-0, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause,
  Apache-2.0, Zlib, CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0, MPL-2.0 (file level;
  modified MPL files stay MPL). CC-BY-4.0 is allowed only for data packages (for example
  browser-support tables), with attribution. OFL-1.1 is allowed only for unmodified font
  binaries shipped with their `OFL.txt` (IBM Plex, D-129); a modified font must be renamed
  as the licence requires.
- **Process-only** (installed by the user, talked to over a protocol, never copied or
  bundled): GPL, AGPL, LGPL binaries, SSPL, BSL/BUSL, FSL, ELv2, custom "community"
  licenses, proprietary tools (Claude Code, LM Studio).
- **Never copied:** code without a license (all rights reserved by default), and anything
  whose license cannot be verified from the source repository.
- Model weights and datasets keep their own licenses; non-commercial (CC-BY-NC) assets are
  linked, not bundled.

## Invariants

- A license gate (`npm run check:licenses`, later also in CI) checks dependency SPDX
  identifiers against the allowlist below and fails on anything else.
- The mobile clients' dependency tree contains no GPL/AGPL code (the same gate runs on the
  mobile workspace once it exists).
- This ADR is the single list of allowed licenses; AGENTS.md and THIRD_PARTY_NOTICES.md link
  here instead of repeating it.
- Attribution is added in the same commit that copies the code.

## Consequences

- Positive: patent grant; standard NOTICE mechanism; App Store compatible; most relevant
  sources (Cordis, DSH, pi, OpenCode, Codex, Goose, Jan, GPUStack, Langfuse core) are
  permissive.
- Negative: AGPL/GPL projects (Cherry Studio, Chatbox, ComfyUI, Serena v2) can only be used
  as separate processes.

## Alternatives considered

- **MIT**: similar compatibility, no patent grant, no NOTICE convention.
- **AGPL-3.0**: would allow copying GPL/AGPL code but conflicts with the App Store and with
  third-party plugins.
