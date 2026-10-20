# Third-party notices

Guanxi reuses open-source work where it fits. Every vendored or adapted file,
snippet, prompt or asset must be listed here with its origin, license and the
local path where it lives. Dependencies installed through a package manager are
covered by their own package metadata and are not repeated here.

| Local path | Origin (repository @ commit) | License | What was taken / how it was changed |
| ---------- | ---------------------------- | ------- | ----------------------------------- |
| `packages/ui/fonts/sans/**`, `packages/ui/fonts/fonts.css` | [IBM/plex @ ceee82fa8878](https://github.com/IBM/plex/tree/ceee82fa88781b8310b198fd302480efaeac609e) (@ibm/plex-sans-variable@0.2.0) | OFL-1.1 | Unmodified upstream WOFF2 slices and license renamed to `OFL.txt`; upstream CSS adapted by Guanxi contributors for local URLs, family alias and `font-display: swap`. |
| `packages/ui/fonts/mono/**`, `packages/ui/fonts/fonts.css` | [IBM/plex @ 2f9ba1b25957](https://github.com/IBM/plex/tree/2f9ba1b25957d958db71a849e85d72e3ecfb845a) (@ibm/plex-mono@2.5.0) | OFL-1.1 | Unmodified upstream WOFF2 slices and license renamed to `OFL.txt`; upstream CSS adapted by Guanxi contributors for local URLs, family alias and `font-display: swap`. |

Rules:

- The allowed, process-only and forbidden licenses are listed once, in
  [ADR-0016](docs/decisions/0016-licensing-and-third-party-reuse.md). Code without a license,
  or whose license cannot be verified from its source repository, is never copied.
- Keep the original copyright header in copied files and add a
  `Modified by Guanxi contributors` line when the file is changed.
- `npm run check:licenses` checks installed dependencies against the same list.
