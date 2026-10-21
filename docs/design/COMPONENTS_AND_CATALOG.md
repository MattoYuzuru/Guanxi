# Components and catalog

**Status:** accepted direction (D-137, D-138); built in stage DS1 · **Updated:** 2026-10-20

Decision record: [ADR-0034](../decisions/0034-design-system-tokens-catalog-and-gates.md).
Evidence: [02 design-system tooling](../research/2026-10-20-design/02-design-system-tooling.md).

## 1. Package and levels

All shared UI lives in `@guanxi/ui` (`packages/ui`). Features and plugins import from it only;
they never import its internals, `@base-ui/react`, `lucide-react` or `motion` directly.

| Level | What | Examples |
| --- | --- | --- |
| primitive | accessible building blocks, copied in once from shadcn/ui on Base UI and owned by Guanxi | Button, IconButton, Input, Textarea, Select, Combobox, Checkbox, Switch, Radio, Slider, Tabs, Tooltip, Popover, Menu, Dialog, Sheet, Toast, Badge, Chip, Kbd, Progress, Skeleton, Separator, ScrollArea, Table, Tree |
| pattern | compositions with Guanxi meaning | Composer, ControlRow, ContextRing, StatusPill, ProvenanceLabel ("source · age"), EmptyState, ErrorState, OfflineState, ToolRow, DiffView, CodeBlock, TerminalView, TraceRow, BlockCard, PaneFrame, NotificationRow, ActionToast, CommandPalette, ModelPicker, AccessModePicker, ProjectPicker, VoiceButton, AttachmentChip, Sparkline, Meter, ProcessTree, LeaseBadge, NodeCard, BoardCard |
| feature | screen parts owned by one feature | session header, new-session screen, settings pages |
| block | layout contributions with card and pane (LAYOUT_AND_SCREENS §5) | Context, Changes, Plan, Processes, … |

## 2. Folder convention (one source for both catalogs)

```text
packages/ui/src/components/<name>/
  <name>.tsx               implementation
  <name>.stories.tsx       portable CSF 3: one story per declared state
  <name>.test.stories.tsx  optional interaction tests (Storybook only)
  <name>.docs.md           frontmatter + required sections
  <name>.review.json       lifecycle status and approval record
  index.ts
```

`<name>.docs.md` frontmatter: `id`, `level`, `states`, `tokens`, `since`. Required sections:
Purpose, When to use, When not to use, Anatomy and variants, States, Accessibility, Content and
i18n, Motion, Do / Don't.

## 3. Catalog

- **In the product** (D-137): Settings → Developer → Components, visible only with Developer
  mode on, lazy-loaded. It renders the same stories with a small interpreter, inside the real
  runtime (fonts, theme plugins, Electron, locale, density), and shows live examples, every
  declared state, usage notes, code, the tokens used, the usage count and the approval status.
  It can switch light, dark, high-contrast, reduced transparency, reduced motion and both
  densities for every component.
- **Storybook** (MIT) reads the same files as the developer, test and agent harness: interaction
  tests, accessibility checks, and its MCP addon for agents (preview feature).
- A generated `manifest.json` (props, exports, status, usage) is what agents and the in-app
  route read; Storybook's own manifest is not relied on while its schema is unstable.

## 4. Lifecycle and approvals (D-138)

```text
draft ──(stories + docs complete)──► review ──(owner approves)──► approved
  ▲                                     │                            │
  │                                     └─(owner requests changes)   ├─(source or snapshot changes)──► stale ──► approved / review
  └── new component (agent)                                          └─(owner deprecates, names replacement)──► deprecated
```

- `stale` is derived from hashes, never stored, so nobody can forget to set it.
- **Approving:** the owner clicks Approve or Request changes in the in-app catalog. The app writes
  the component's `review.json` (status, date, source hash, snapshot hashes, comment) and signs
  the record through the installed Secure Enclave signing helper (D-184), which requires the
  owner's presence for every signature; the public key is committed in the repository. Agents can
  create and update `draft` and `review` records but cannot produce a valid approval signature.
  Approvals are written only when the app runs from a source checkout; release builds show the
  catalog read-only.
- **Requests for changes** become work items for agents through the work ledger (ADR-0032).
- **What blocks what:**

| Situation | Every slice | Release or stage exit |
| --- | --- | --- |
| A product screen or plugin uses a `draft` component | blocked | blocked |
| Uses a `review` or `stale` component | warning, listed in the hand-off | blocked |
| New use of a `deprecated` component | blocked | blocked |
| Draft used only in the catalog | allowed | allowed |

### 4.1 Review record format (stable; DS2 signs it)

**Status:** implemented (lane DS1-b, 2026-10-21). The DS2 signing helper (D-184) signs exactly
these payloads; a change to them is a new schema version.

`packages/ui/src/components/<id>/<id>.review.json`, validated by `catalog/review.schema.json`
and `parseReviewRecord` (unknown fields are rejected), written by the node in one serialisation
(`serialiseRecord`; G12 rejects any other bytes for a signed record):

| Field | Written by | Meaning |
| --- | --- | --- |
| `id`, `status` | agents, node | `draft`, `review`, `approved` (needs a valid approval at the chain head) or `deprecated` (needs `deprecated`) |
| `approval` | owner (signed) | `{ at, sourceHash, snapshotHashes, comment, keyId, previous, signature }` |
| `revocation` | owner (signed) | the owner's "request changes" on an approved record: `{ at, keyId, previous, signature }` |
| `deprecated` | agents | `{ at, replacement, note }`; the approval stays, so the chain stays intact |
| `requests` | agents, node | change requests `{ id, at, text, state: open \| resolved }` |

Signed payloads (ECDSA P-256 (SHA-256, IEEE P1363) over canonical JSON: keys sorted by UTF-16
code unit, no whitespace, UTF-8; signatures are 64-byte r‖s values, base64 encoded):

- approval: `{ schema: "guanxi.ui-approval/3", id, status: "approved", at, sourceHash,
  snapshotHashes, comment, keyId, previous }`;
- revocation: `{ schema: "guanxi.ui-revocation/3", id, decision: "request_changes", at, keyId,
  previous }`.

The `/2` (Ed25519) schema was never used and is removed.

**Hash chain.** `previous` is the digest of the signed decision the new one supersedes, or
`null` for the first: `sha256:` + hex SHA-256 of the canonical JSON of that decision's payload
plus its `signature`. The node sets it to the record's current head when it signs. With both an
approval and a revocation in a record, exactly one names the other; that one is the head, the
owner's current decision (a revocation head revokes the approval).

**What G12 enforces across history.** G12 walks every committed version of each record: every
commit reachable from HEAD that changed it, on every side of every merge, as a graph with each
version checked against the merged state of all its parents (components whose folder was deleted
are found from history too). It validates each version like the working tree: signatures,
status, and the chain between its decisions. A merge must keep or descend from every parent's
current decision; parents whose decision histories diverge fail. Every signed decision must root in a `previous` of `null`
through decisions some committed version held. A version keeps the owner's current decision
(the ledger head) or replaces it with one that descends from it, so review cycles of any length
verify and an older decision can never come back. A deprecation stays until a newer signed
decision supersedes it, and removing the record or the component folder while it holds a
decision or a deprecation fails. A break in any committed version fails G12 for good: restoring
a later version does not repair history (recovery needs an owner-signed mechanism, DS2).
Unsigned changes to `status` (draft, review), `requests` and new deprecations stay allowed.
Shallow clones fail closed. A decision deleted before it ever reached a committed version cannot
be recovered.

## 5. Gates

Every gate ships with a seeded violation that must make it fail; a self-test gate runs them all.
`npm run ui:check` runs the fast gates; `npm run ui:check:browser` runs the browser ones; both
emit JSON for agents.

| # | Gate | Fails when |
| --- | --- | --- |
| G1 | Tokens valid | an alias is broken, a type is wrong, or a colour lacks its hex fallback |
| G2 | Generated output fresh | regenerating tokens changes committed output |
| G3 | Contrast | any listed foreground/background pair is below its ratio in any theme (text 4.5:1, large and UI 3:1, high-contrast themes 7:1) |
| G4 | Variables resolve | any `var(--x)` is not a generated token or an allow-listed local variable (catches today's undefined `--warning` and `--focus`) |
| G5 | No literal classes | a class is unknown to the compiled theme or uses an arbitrary value outside an allow-list |
| G6 | No literal CSS values | colours, spacing, font sizes, z-index or motion in CSS use raw values |
| G7 | No literal motion | raw durations, easings or delays anywhere |
| G8 | Import boundaries | features or plugins import UI internals or underlying libraries directly |
| G9 | Reuse primitives | features render raw `button`, `input`, `select`, `textarea`, `dialog` or style colours inline |
| G10 | Catalog complete | an exported component lacks a story per declared state, a complete docs file or a review record, or a catalog entry is orphaned |
| G11 | Status policy | the table in §4 is violated |
| G12 | Approval integrity | an `approved` record lacks a valid owner signature over its hashes |
| G13 | Visual regression | a story differs from its baseline in light, dark (and high-contrast for primitives); baselines are produced only in a pinned Playwright Docker image |
| G14 | Accessibility | any serious or critical axe violation in a story or in the new-session and settings flows |
| G15 | i18n | literal user-facing text, or a story that clips in Russian or a +40% pseudo-locale |
| G16 | Reduced motion | a story still moves or loops under reduced motion |
| G17 | Gates self-test | any seeded violation passes its gate |

Existing violations in the legacy web package are frozen with ESLint bulk suppressions; the
suppression file may only shrink, and U1 cannot exit while colour rules have suppressions. A
codemod rewrites the 683 `bg-[var(--x)]` uses to semantic utilities.

## 6. Building UI as an agent

Load the [`guanxi-ui` skill](../../.agents/skills/guanxi-ui/SKILL.md). In short:

1. Search the catalog before writing any JSX.
2. Use an approved component; else add a variant to an existing one; else compose a pattern from
   primitives; only then create a new component (status `draft`).
3. Tokens only; if no token fits, propose one, do not invent it.
4. Cover every declared state with a story.
5. Locale keys only; motion tokens only; reduced motion honoured.
6. Run `ui:check` (and `ui:check:browser` for visual changes); never edit generated files; never
   set `approved`.
7. Hand off with the components touched, their status changes and catalog links for the owner.

## 7. Review checklist

- [ ] `ui:check` and `ui:check:browser` are green; the suppression file did not grow.
- [ ] No new component where an existing one or a variant would do (cite the catalog search).
- [ ] New or changed components have stories for all states, complete docs and a review record.
- [ ] Light, dark, both high-contrast themes, both densities and all three glass levels look
      right; snapshot diffs were inspected, not just accepted.
- [ ] Keyboard-only walk-through, including moving a block without dragging; names and live
      regions checked; focus visible in forced colours.
- [ ] Motion uses tokens only; reduced motion checked; streaming text does not animate.
- [ ] No literal strings; Russian present and fitting; pseudo-locale does not clip.
- [ ] Plugin UI uses only `@guanxi/ui` and semantic tokens; iframe plugins take their colours
      from the MCP Apps variables.
- [ ] Every number shown has a source and an age; unknown values render as unknown.

## 8. Implementation status (lane DS1-b, 2026-10-20)

Built on the DS1-b lane branch; see [`packages/ui/AGENTS.md`](../../packages/ui/AGENTS.md) and the
lane hand-off for evidence.

- `@guanxi/ui` has 14 primitives (shadcn/ui on Base UI, adapted) and 4 patterns (StatusPill,
  ProvenanceLabel, EmptyState, ErrorState), all `draft`. They style through DS1-a's generated
  tokens (`packages/ui/generated/tokens.css`); values no token expresses come from Tailwind
  utilities through `@apply`, so G1–G7 pass on the components. The spinner and the running pulse
  stay still until the generated theme offers a loop animation (G6 rejects keyframe names).
- The in-app catalog is at Settings → Developer → Components (`/settings/developer/components`),
  code-split and shown only with Developer mode on. Links keep the component and regime in the
  query (`?component=button&theme=dark-hc&density=comfortable&glass=solid`).
- Approvals (§4) go through the node, not a Vite middleware: `GET/POST
  /api/ui-catalog/components/<id>/review` writes `<id>.review.json` only from a source checkout and
  never in a release build. The approval is an ECDSA P-256 signature inside the record, produced
  by the installed Secure Enclave signing helper (D-184) after Touch ID or the owner's password;
  the node never receives the private key. Public keys are in
  `packages/ui/catalog/approval-keys.json`; the owner installs the helper with
  `node packages/server/scripts/install-approval-signer.ts` and creates the key with
  `node packages/ui/catalog/scripts/approval-key.ts init`.
- **What the signature does and does not prove.** It proves that the helper used the owner's
  Secure Enclave key after the owner passed the presence check, and that the signed payload names
  the component and its source hash. A process that obtains the wrapped blob and the owner's touch
  can still ask for a signature while showing a misleading reason; every signature still requires
  that touch. Ad-hoc signing changes the helper's code identity on every rebuild, so its keychain
  access list must be re-granted by re-running `init` with a new key. Never choose "Always Allow"
  for the keychain item.
- G10–G16 are registered with DS1-a's runner (`packages/ui/gates/extensions/catalog.gate.ts`):
  `npm run ui:check` runs them with G1–G7 and G17 (fast: G10, G11, G12, G15 literals), and
  `npm run ui:check:browser` runs the browser ones and their G17 seeds (G13 in the pinned
  Playwright image, G14, G15-clipping, G16). The catalog runner
  (`packages/ui/gates/catalog/run.ts`) stays for targeted work: `npm run ui:catalog:selftest`
  runs every seed of every catalog gate (G17 runs one per gate), and `npm run ui:snapshots`
  rewrites G13 baselines.
