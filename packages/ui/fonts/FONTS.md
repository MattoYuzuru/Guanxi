# Self-hosted Plex

IBM Plex Sans Variable 0.2.0 and IBM Plex Mono 2.5.0 come from the
[IBM releases](https://github.com/IBM/plex/releases). `sources.json` records each release,
commit, archive checksum, upstream path and shipped-file checksum. Each family's `OFL.txt`
is the unmodified upstream license (SIL OFL 1.1, Reserved Font Name “Plex”). No font binary
was subsetted, converted or renamed. The owner explicitly selected these OFL fonts for DS1.

`fonts.css` adapts upstream stylesheets: local URLs only, no installed-font shortcut,
`font-display: swap`, and the CSS alias `IBM Plex Sans` for the upstream Sans Var family.
Copyright and license remain with IBM. Attribution is in `THIRD_PARTY_NOTICES.md`.

- Sans: Roman and italic variable faces, weights 100–700; upstream Latin1/2/3, Cyrillic,
  Greek and symbols slices, each with its upstream `unicode-range`.
- Mono: regular/italic at 400 and 600, with upstream Latin1/2/3, Cyrillic and symbols slices.
  IBM's Mono archive does **not** include the Greek alphabet (only π in the symbols slice).
  Greek machine values therefore use the OS mono fallback; this differs from FOUNDATIONS
  §2.1's coverage claim and is reported for integrator reconciliation.
- No optional script companion pack ships. The base upstream Latin3 slices also cover
  Vietnamese; they are part of the base face, not a companion pack.

Import `@guanxi/ui/tokens.css` once (it imports `fonts.css`), or import
`@guanxi/ui/fonts.css` directly. URLs remain relative so Vite emits local hashed assets.
Only these two Latin1 faces are preload candidates; all other slices load on demand:

1. `sans/IBM Plex Sans Var-Roman-Latin1.woff2`
2. `mono/IBMPlexMono-Regular-Latin1.woff2`

The built-app Playwright test explicitly loads Latin, Cyrillic and Sans Greek faces, checks
that actual font requests occur, rejects every different origin and rejects failed loads.
A second test injects a blocked external font and proves the request observer detects it.
