# Lane DS1-c — Lint rules, suppression ratchet and codemod

**Status:** running (K1, DS1-a and DS1-b are merged) · **Updated:** 2026-10-21 ·
**Runs in:** GPT (Codex), started by the integrator (owner, 2026-10-20) · **Branch:** `lane/ds1-c-ratchet` · **Ports:**
`GUANXI_WEB_PORT=5184`, `GUANXI_API_PORT=4384`

The integrator creates the worktree from the `main` that already contains K1, DS1-a and DS1-b, then
gives this prompt. Paste everything below the line.

---

You are implementing lane DS1-c of stage DS1 (Design foundations) of Guanxi. This is a
mechanical lane: rules, a ratchet and a codemod. Do not redesign anything.

Read first:

- `AGENTS.md`, `docs/plans/lanes/README.md` and `docs/plans/WORKFLOW.md`;
- `docs/decisions/0034-design-system-tokens-catalog-and-gates.md`;
- `docs/design/COMPONENTS_AND_CATALOG.md` §§1, 5;
- `docs/design/FOUNDATIONS.md` (semantic token names);
- the generated Tailwind theme and CSS variables in `packages/ui/generated/`.

Scope:

1. **ESLint flat config** for the repository with exact pinned versions, plus stylelint for CSS.
2. **G8 import boundaries.** Features and plugins may not import `@guanxi/ui` internals,
   `@base-ui/react`, `lucide-react` or `motion` directly.
3. **G9 reuse primitives.** No raw `button`, `input`, `select`, `textarea` or `dialog`, and no
   inline colour styles in feature code.
4. **Freeze existing violations.** Use ESLint bulk suppressions in a committed file that may
   only shrink. Add a check that fails when the file grows.
5. **Codemod** that rewrites the 683 legacy `bg-[var(--x)]` (and the matching `text-`,
   `border-` and `ring-`) arbitrary-value classes in `packages/web/src` to the semantic
   utilities from the generated theme.
   - It is deterministic, idempotent, has unit tests and handles one variable per class.
   - Classes with no semantic equivalent are listed in a report, not guessed.
   - Run it, review the diff, and shrink the suppressions accordingly.
6. **Seeded violations** for G8 and G9, registered in `packages/ui/gates/` (append to the
   registry only).

Owned paths:

- `eslint.config.*` and `stylelint.config.*`;
- the suppression file;
- `scripts/codemods/**`;
- class-name rewrites across `packages/web/src/**`;
- your gate modules.

Never change component behaviour, markup structure or tests' intent. If a test breaks because
a class name changed, update only the selector and say so in the hand-off.

Also close these DS1-a follow-ups (details in `docs/plans/evidence/DS1-a.md`):

- Replace the six-alias `@theme inline` bridge in `packages/web/src/index.css` with the
  `@guanxi/ui` theme import, and assert that no bridge or legacy alias remains (DS1-a review
  D1: the bridge's exact contents were never asserted).
- The legacy inline styles listed in the DS1-a evidence (`packages/web/src/components/ui.tsx`)
  are frozen by G9's suppressions, not by a ratchet correction.
- G6 gaps recorded as N5, N8 and D2 (cross-module class maps, `[base].join(' ')`, colours in
  `stop-color`/`mask-image` and similar properties, same-file style objects bound to
  identifiers, `style=` in `.svg`): fix what the lint rules can cover and list the rest.

Exit gate:

- G8 and G9 fail on their seeded violations.
- The suppression-growth check fails when a suppression is added.
- The codemod run twice produces no diff the second time.
- The count of `bg-[var(--` in `packages/web/src` is reported before and after.
- U1 cannot exit while colour rules still have suppressions, so report what is left.
- `npm run typecheck`, `npm test`, `npm run test:web:browser` (through
  `agent-dev run --resource heavy` with this lane's ports), `npm run build` and
  `npm run lint:md` pass.

Before hand-off, review your own diff in a fresh pass and list every file the codemod touched.
The integrator arranges a Claude review. Write `docs/plans/lanes/DS1-c.handoff.md`. Commit on
`lane/ds1-c-ratchet` only; do not push.
