# ADR-0022: Plugin trust tiers, UI slots and design tokens

**Status:** proposed · **Date:** 2026-10-19

## Context

Everything should be a plugin, including UI; agents may write plugins; all UI must match one
style guide (REQ-F1, REQ-F2, REQ-K4). Lane 2 found that no in-process plugin system isolates plugins (VS
Code, Obsidian, OpenCode, Pi, DSH, Cordis); in-process JavaScript sandboxes have a history of
escapes (Figma moved from Realms to a WebAssembly VM).

## Decision

1. **Trust tiers**:

   | Tier | Who | Runs | Rights | How it gets in |
   | --- | --- | --- | --- | --- |
   | T0 core | Guanxi repository | in-process | full | release build |
   | T1 trusted | admin-installed, official registry | in-process | full (documented honestly) | pinned spec with integrity hash, `engines.guanxi` check |
   | T2 untrusted | agent-written, unreviewed third party | out-of-process MCP server in an OS sandbox, or WASM (Extism) | declared capabilities only, through a broker: fs roots, network allowlist, secret refs, model budget | default for agent-written plugins; promotion to T1 needs owner review, tests and signature |

2. **Manifest**: a `guanxi` field in `package.json` with `id`, `engines.guanxi`, `provides`,
   `requires`, `uses`, `contributes` (slots, settings pages, locales, themes, commands, tools,
   message renderers by MIME or tool name, composer actions), `capabilities` (T2) and `trust`.
3. **UI extension**: typed slots modelled on DSH (`single`, `list`, `keyed`, `chain`);
   declaring a slot means owning it; contributing to an undeclared slot fails at load. T2 UI
   appears only as MCP Apps in a sandboxed iframe on a separate origin.
4. **Design system**: tokens in W3C DTCG 2025.10 format are the single source; Style
   Dictionary generates CSS custom properties, a Tailwind v4 theme, TypeScript types and the
   MCP Apps variables (`HostContext.styles.variables`), so T2 UI inherits the theme by
   construction. Components: shadcn/ui on Base UI (copied in), Lucide icons, assistant-ui,
   Streamdown, CodeMirror 6.
5. **Style rules enforced by a plugin gate**: no literal colours in features, reuse a
   primitive before restyling, one primitives catalogue, theme spec tests, ESLint/stylelint
   rules, visual snapshots and an accessibility check. Agents get a `guanxi-ui` skill with the
   component catalogue.
6. **Themes and locales are data-only plugins** (token JSON, locale key dictionaries) and are
   safe even as T2.
7. **Plugin manager**: install with rollback of manifest and lockfile, engine and peer checks
   before download, separate approval for build scripts, an agent-facing `plugin_manager`
   tool (adapted from DSH, MIT).
8. **Versioning**: `@guanxi/plugin-api` follows semver with a one-minor deprecation window.
9. **MCP servers**: off by default; enabled per project. Every MCP server is treated as T2:
   it runs out of process under the same OS sandbox profile as agent tools
   (`sandbox-runtime`, available from stage K4), with declared fs roots, a network allowlist
   and secret references only. Remote (HTTP) MCP servers go through the egress proxy and its
   allowlist. MCP spec version is pinned (`2026-07-28` at the time of writing). Tool
   descriptions count against a per-session tool budget; large servers are exposed through a
   search/load tool instead of loading every description.
10. **Skills and instructions**: Agent Skills are discovered from the project
    (`.agents/skills/`, `.claude/skills/`) and the user profile; only name and description
    enter the context until a skill is invoked (progressive disclosure). `AGENTS.md` is loaded
    from the nearest directory up to the project root, with a size budget; overflow is
    reported, not silently truncated. Skills are data plus optional scripts; scripts run as
    tools under the sandbox.

## Invariants

- A T2 plugin cannot read a secret value, a path outside its declared roots, or reach a host
  outside its allowlist.
- Unloading any plugin removes every UI contribution it made.
- Safe mode disables all T1 and T2 plugins.

## Validation

An MCP server installed in stage P1 cannot read or write outside its declared roots or reach
a host outside its allowlist; skill bodies are absent from the context until invoked (token
count assertion); sandbox escape tests for T2 (fs, network, secrets); slot ownership tests;
visual and lint gate
on a sample agent-written plugin; a theme switch changes T2 iframe colours without plugin code
changes.

## Evidence

Lane 2 §§1, 3 ([research](../research/README.md)); MCP Apps specification (2026-01-26); W3C
DTCG Format Module 2025.10.
