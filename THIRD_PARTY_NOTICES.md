# Third-party notices

Guanxi reuses open-source work where it fits. Every vendored or adapted file,
snippet, prompt or asset must be listed here with its origin, license and the
local path where it lives. Dependencies installed through a package manager are
covered by their own package metadata and are not repeated here.

| Local path | Origin (repository @ commit) | License | What was taken / how it was changed |
| ---------- | ---------------------------- | ------- | ----------------------------------- |
| `packages/server/src/connections/metadata/models-dev.json`, `LICENSE.models.dev` | [anomalyco/models.dev @ f51a64b](https://github.com/anomalyco/models.dev/tree/f51a64b180710b91a1243868488a55dd359e8b86) | MIT | Two model metadata records converted from TOML to JSON (Modified by Guanxi contributors), with source and observation time; original MIT license retained. |

Rules:

- The allowed, process-only and forbidden licenses are listed once, in
  [ADR-0016](docs/decisions/0016-licensing-and-third-party-reuse.md). Code without a license,
  or whose license cannot be verified from its source repository, is never copied.
- Keep the original copyright header in copied files and add a
  `Modified by Guanxi contributors` line when the file is changed.
- `npm run check:licenses` checks installed dependencies against the same list.
