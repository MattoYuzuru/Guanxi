# Third-party notices

Guanxi reuses open-source work where it fits. Every vendored or adapted file,
snippet, prompt or asset must be listed here with its origin, license and the
local path where it lives. Dependencies installed through a package manager are
covered by their own package metadata and are not repeated here.

| Local path | Origin (repository @ commit) | License | What was taken / how it was changed |
| ---------- | ---------------------------- | ------- | ----------------------------------- |
| _none yet_ |                              |         |                                     |

Rules:

- The allowed, process-only and forbidden licenses are listed once, in
  [ADR-0016](docs/decisions/0016-licensing-and-third-party-reuse.md). Code without a license,
  or whose license cannot be verified from its source repository, is never copied.
- Keep the original copyright header in copied files and add a
  `Modified by Guanxi contributors` line when the file is changed.
- `npm run check:licenses` checks installed dependencies against the same list.
