# Lane 3 — typography and visual identity derived from the gx logo

**Status:** `proposed` — research and options for an owner decision; nothing here is accepted or
implemented. **Date:** 2026-10-20; every external source was opened on this date unless noted.
**Scope:** font roles (UI text, display, monospace), multi-script fallback, font loading for
Electron and the web client; two to three visual-identity directions derived from
`assets/brand/guanxi-gx-v1` (ink `#182322`, ivory `#F4F2E9`).

**Evidence labels.** **[V]** = checked in a primary source (GitHub REST API for licence, stars and
releases; the LICENSE/OFL file itself; Google Fonts metadata JSON; Google Fonts CSS2 API; foundry
README; MDN browser-compat-data; Electron PR). **[I]** = inference or secondary source.
All colour numbers (OKLCH, hex, WCAG 2.2 ratio, APCA Lc, colour-vision-deficiency distances) were
computed in this lane with a scratchpad script: sRGB↔OKLab per Ottosson, WCAG 2.x relative
luminance, APCA-W3 0.0.98G-4g constants (self-checked against the reference values black on
white Lc 106.0 and #888 on white Lc 63.1), CVD simulation with Machado 2009 severity-1.0
matrices. They are **[V-computed]**: reproducible arithmetic, not a user study.

**How fonts were measured.** Subsets, axes, date added and popularity rank come from
`fonts.google.com/metadata/fonts` [1]. WOFF2 sizes for Google-hosted families are the
`Content-Length` of the files referenced by the Google Fonts CSS2 API (HEAD request, variable
font, normal style) [2]. Sizes for GitHub-hosted fonts are git-tree blob sizes or release asset
sizes from the GitHub API. No font binaries were downloaded or opened, so **glyph counts are given
only where the foundry publishes them**. Elsewhere coverage is given as Google Fonts subsets or the
foundry's language list.

---

## 0. Summary for the owner

1. **The honest "non-generic" problem.** By late 2026 the escape fonts have themselves become
   AI defaults. Anthropic's own published prompt tells models to avoid Inter and Roboto and to use
   *"JetBrains Mono, Fira Code, Space Grotesk"* for a code aesthetic and the *"IBM Plex family"*
   for a technical one [3]. claude.ai loads JetBrains Mono as its monospace [I, 4]. A community
   slop-linter proposal lists Inter, Geist, Space Grotesk, Instrument Sans/Serif, Fraunces,
   Mona Sans and Plus Jakarta Sans among its tells [5]. JetBrains Mono and Plex are therefore
   *safe and excellent*, but they will not make Guanxi look hand-designed on their own. The
   distinctiveness has to come from the proportional face, the colour system and the material —
   and, if the owner wants it, from a custom-configured monospace.
2. **The ivory problem.** The owner's ivory `#F4F2E9` sits ΔE_OK ≈ 0.3 from the most-cited
   AI-generated look: "a warm cream background (near #F4F1EA) with a high-contrast serif display
   and a terracotta or warm-clay accent" [6]. That difference is invisible. Ivory is still right
   for the mark. It becomes a tell only when combined with a serif display and a clay accent.
   Directions B and C below move the UI canvas off cream. Direction A keeps it and explicitly
   forbids the other two ingredients.
3. **Recommended pairing (proportional + mono): Commissioner + JetBrains Mono.** Commissioner is
   OFL with no Reserved Font Name. It covers Latin, Cyrillic Pro and Greek. It has weight and slant
   axes plus two unusual ones: `FLAR` (flare — grotesque terminals swell into glyphic serifs) and
   `VOLM` [7]. One file can serve calm UI text at `FLAR 0` and a calligraphic, "ink-touched"
   display at high flare that rhymes with the logo's brush-like `g`. It appears on none of the
   cliché lists found. JetBrains Mono stays for code, logs and metrics because the owner likes it
   and it has the best Latin/Cyrillic/Greek coverage of the shortlisted monos (148 languages) [8].
4. **Mono-first alternative: a custom Iosevka build ("Guanxi Mono" + "Guanxi Aile"), with Sarasa
   Gothic for CJK terminals.** Iosevka is OFL without a Reserved Font Name and supports 248
   languages including Greek and Russian. It is configured glyph by glyph, including an open
   single-storey `g` that can echo the logo [9]. It is the only path to a monospace that is
   Guanxi's own rather than a recognisable default.
5. **Coverage-first alternative: the IBM Plex superfamily.** Plex is the only open family with a
   designed-together set for Latin, Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai, Japanese,
   Korean and Simplified and Traditional Chinese [10]. Costs: it is on the AI "technical" list [3];
   it has the Reserved Font Name "Plex"; and its npm packages run an IBM telemetry `postinstall`
   (CI only, per IBM) [11] [12]. Vendor the files instead.
6. **CJK and 关系.** Do not bundle a CJK font by default. Use the operating-system CJK faces first
   (preinstalled on macOS and Windows). Ship an optional CJK pack for Linux and the web client.
   **Outline 关系 as SVG paths in the logo lockup** so the brand never depends on a 4–18 MB font.
7. **Identity directions.** A "Ink & Paper": warm, calm, ivory canvas, verdigris accent.
   B "Glacier": cool frost canvas, meltwater accent, frosted glass with grain on floating layers
   only. This is the owner's DeepSeek-Harness-inspired look, with a solid fallback driven by
   `prefers-reduced-transparency` and `nativeTheme.prefersReducedTransparency`. C "Loom":
   mono-first, ink-graphite, brass + kingfisher accents, borders instead of shadows. All three use
   the brand ink `#182322` (or a near neighbour) as the dark canvas. Ink is lighter and greener than
   the "tinted near-black" cliché, and it makes the logo's two colours literally the two themes.

---

## 1. Typography

### 1.1 Candidate register

Legend. **Scripts** = Google Fonts subsets (GF) or foundry statement; "Cyr" includes Russian.
**Size** = variable WOFF2 per normal style unless noted. **Slop risk** = how strongly sources tie
the face to AI-generated design. High = named as a tell. Rising = named as a *recommended
alternative* in model prompts, so it is becoming a default. Low = not found in any such list.
This is an evidence-based judgement, not a frequency measurement.

| Family | Licence (RFN) | Scripts | Axes / styles | Size (WOFF2) | Hinting / rendering | Maintenance | Slop risk | Verdict |
|---|---|---|---|---|---|---|---|---|
| **JetBrains Mono** | OFL-1.1, no RFN [V 13] | Latin, Latin-ext, Cyr, Greek, Vietnamese (GF) [V 1]; "148 languages" [V 8] | `wght` 100–800 + true italics [V 1] | latin 40.5 KB, cyrillic 12.1 KB, greek 9.1 KB, latin-ext 15.2 KB [V 2] | Increased x-height "helps improve rendering in small size" [V 13] | Last release v2.304 (2023-01-14); repo pushed 2025-01-31 [V 14] | **Rising**: in Anthropic's recommended list [3]; claude.ai mono [I 4] | **Keep for code/logs** (owner preference, best coverage) |
| **IBM Plex Sans** (variable) | OFL-1.1, **RFN "Plex"** [V 15] | Latin, Cyr (194 glyphs/font), Greek (74 glyphs/font) [V 16] | `wdth` 75–100, `wght` 100–700 [V 1]; Condensed is now a width axis | complete roman 230 KB; GF latin 60 KB, cyrillic 42 KB, greek 25 KB [V 2, 17] | Variable TrueType hinting "for better rendering on Windows" [V 16] | Active (repo pushed 2026-10-16) [V 14] | **Rising**: "Technical: IBM Plex family" [3] | Coverage-first option |
| IBM Plex Mono | OFL, RFN "Plex" | Latin, Cyr, Vietnamese on GF; v2.5.0 adds transliteration sets [V 1, 16] | variable `wght` 100–700 since 2026-07-30 [V 16] | ~10 KB latin per static weight [V 2] | hinted | Active | Rising | Pairs only with Plex |
| IBM Plex Sans JP / KR / SC / TC | OFL, RFN "Plex" | JP: Japanese + Latin + Cyr; KR: Hangul + Latin (**no Hanja, so 关系 is not covered** [V 2]); SC: 29,562 glyphs/font [V 16] | 7 static weights each | SC Regular complete WOFF2 3.8 MB; GF serves JP as 123 slices [V 17, 2] | hinted and unhinted builds [V 17] | Active | Rising | Best matched CJK if Plex is chosen |
| IBM Plex Sans Arabic / Hebrew / Devanagari / Thai (+Looped) | OFL, RFN "Plex" | each adds its script to Latin [V 1] | 7 static weights | n/m | hinted | Active | Rising | Best matched non-Latin set among open fonts |
| **Monaspace** Neon / Argon / Xenon / Radon / Krypton | OFL-1.1, **RFN "Monaspace" + subfamily names** [V 18] | **v1.400 (2026-03-28) adds Cyrillic, Greek, Vietnamese** [V 19] | `wght` 200–800, `wdth` 100–125, `slnt` 0 to −11 [V 20]; five metric-compatible voices: neo-grotesque, humanist, slab, handwriting, mechanical [V 20] | variable WOFF2 445–796 KB per voice, unsubsetted [V 21] | "Frozen" builds with features baked in; NerdFont builds [V 19]; hinting not documented [I] | Active | Low–Rising (GitHub-branded; not in the prompts found) | Strong mono-first alternative ("voices" per actor) |
| **Commit Mono** | OFL-1.1 for the font (site code MIT) [V 22] | Latin + Greek; **"Support for Cyrillic coming soon"** [V 23] | 400/700 + italics; variable in the design download [V 23] | n/m | "Smart kerning" through `calt` [V 23] | Release v1.143 (2023-12-28) [V 14] | Low | **Rejected: no Russian** |
| **Iosevka** (custom build) | OFL-1.1, **no RFN** [V 24] | Latin, Greek incl. polytonic, Cyrillic; 248 languages incl. Russian [V 9] | 9 weights, widths, per-character `cv`/`ss` variants; Aile (quasi-proportional) and Etoile (slab) siblings [V 9, 25] | Release webfont packages are huge because they contain every style; a custom 3-weight Latin+Cyr+Greek build is far smaller [I] | hinted (ttfautohint) and unhinted packages [V 25] | Very active: v34.9.0 (2026-09-26) [V 14] | Low (a custom build has no recognisable default look) | **Mono-first recommendation** |
| Sarasa Gothic | OFL-1.1 (composite of Inter, Iosevka, Source Han Sans) [V 26] | full CJK (SC/TC/HK/JP/KR) + Latin/Greek/Cyr [V 26] | static weights | TTC packages 100–400 MB zipped [V 27] | hinted and unhinted [V 27] | Active: v1.0.42 (2026-09-26) [V 14] | Low | Desktop terminal CJK fallback only; not a web font |
| Recursive | OFL-1.1 [V 14] | Latin + Vietnamese; **Cyrillic-ext only, no Russian** [V 1, 28] | `MONO` 0–1, `CASL` 0–1, `wght` 300–1000, `slnt` −15–0, `CRSV` [V 28] | n/m | — | Last release 2022 [V 14] | Low | Rejected (no Russian) |
| Mona Sans / Hubot Sans | OFL-1.1 [V 14] | Latin + Vietnamese only [V 1] | `wdth` 75–125, `wght` 200–900, `opsz` (Mona v2) [V 29] | latin 98 KB [V 2] | — | Mona active (v2.0.27) [V 14] | **High**: on slop list [5] | Rejected (no Cyrillic, cliché) |
| **Onest** | OFL-1.1, no RFN [V 30] | Latin, Cyr, math, symbols, Vietnamese; **no Greek, no italic** [V 30] | `wght` 100–900 [V 1] | latin 33.8 KB, cyrillic 15.8 KB [V 2] | — | GF updated 2026-08-25 [V 1] | Low | Good Russian UI face; fails Greek |
| Golos Text / Golos UI | OFL-1.1 [V 30]; Golos UI OFL per ParaType [I 31] | Latin + Cyr; no Greek [V 1] | Text: `wght` 400–900; UI: uniwidth R/M/B + VF [I 31] | latin 38 KB, cyrillic 22 KB [V 2] | designed for screen | GF updated 2025-09 [V 1] | Low | Fails Greek; strong for Russian-only |
| **Martian Mono** | OFL-1.1, no RFN [V 32] | Latin + Cyr; **no Greek** [V 1] | `wdth` 75–112.5, `wght` 100–800 [V 1] | latin 38 KB, cyrillic 17 KB [V 2] | "OpenType and TrueType hinting", heights on the pixel grid [V 33] | Release v1.1.0 (2025-02) [V 14] | Low | Distinctive; fails Greek |
| **Commissioner** | OFL-1.1, **no RFN** [V 7] | Latin Plus/Pro, Cyrillic Plus/Pro (+`locl`), Greek Core [V 7]; GF subsets cyrillic, greek, latin, vietnamese [V 1] | `wght` 100–900, `slnt` 0 to −12, `FLAR` 0–100, `VOLM` 0–100 [V 7] | variable TTF ≈ 670 KB unsubsetted; Fontsource variable package 1.38 MB unpacked (all axes, all subsets) [V 34, 35] | not documented [I] | Release 1.012 (2025-11-18) [V 14] | **Low** (not found in any list) | **Proportional recommendation** |
| Berkeley Mono | **Proprietary**. Developer licence $75, "Commercial Use · No"; app embedding needs a negotiated licence [I 36] | — | — | — | — | — | Low | **Excluded**: cannot ship in an Apache-2.0 app |
| Noto Sans / Sans Mono / Sans CJK, Source Han Sans | OFL-1.1; RFN "Source" for Adobe-derived CJK [V 15, 37] | effectively every script [I] | Noto Sans `wdth`+`wght`; Noto Sans SC `wght` 100–900 [V 1] | Noto Sans SC served as 101 unicode-range slices; family TTF 17.8 MB [V 1, 2] | hinted | Source Han Sans 2.005R (2025-06-18) [V 14] | n/a (fallback) | **Universal fallback** |
| LXGW WenKai (霞鹜文楷) | OFL-1.1, RFN "霞鹜 / LXGW"; web-subsetting exception only for approved platforms [V 38] | full CJK Unified basic block (20,992) + Ext-A (6,592) [V 38]; the GF "TC" variant adds Greek/Cyr [V 1] | 3 weights | GF serves TC as 115 slices; family TTF 13.3 MB [V 1, 2] | — | Very active (v1.530, 2026-10-17) [V 14] | Low | Optional Chinese brand/display flavour; outline 关系 instead |
| Inter, Geist, Space Grotesk, Manrope, Fraunces | OFL | — | — | — | — | — | **High** [3, 5, 39] | Excluded by the brief |

n/m = not measured in this lane.

**Rendering notes [I].** macOS (Core Text) ignores TrueType hinting and renders with greyscale
anti-aliasing. Hinting therefore matters only on Windows (DirectWrite/ClearType at 96–120 dpi) and
on Linux (FreeType, typically `hintslight`). For Windows users on 1080p monitors prefer hinted
builds of JetBrains Mono, Plex, Martian Mono or Iosevka. For variable fonts without documented
hinting (Commissioner, Monaspace) test 12–14 px text on a 96-dpi Windows machine before
committing. Electron uses Chromium's text stack on all three platforms, so the result matches
Chrome on that OS.

### 1.2 Licence mechanics that affect the build

- **OFL Reserved Font Names and subsetting.** The OFL FAQ treats subsetting a web font and most
  format conversions as creating a Modified Version. A Modified Version may not use a Reserved
  Font Name unless "Functional Equivalence" is preserved (FAQ 2.2, 2.6–2.8) [40]. Practical rule:
  - fonts **without** an RFN (JetBrains Mono, Commissioner, Iosevka, Martian Mono, Onest) can be
    subset freely, renamed or not;
  - fonts **with** an RFN (Plex, Monaspace, Source/Noto CJK, LXGW) should ship as upstream files,
    including upstream-made split files (IBM ships `fonts/split/woff2`). If we subset them
    ourselves, rename them (for example `gx-sans-cjk`) and keep the OFL and copyright notice.
- **IBM Plex npm packages.** `@ibm/plex-*` packages declare
  `"postinstall": "ibmtelemetry --config=telemetry.yml"` and depend on `@ibm/telemetry-js` [V 12].
  IBM states that collection runs only in CI and honours `IBM_TELEMETRY_DISABLED=true` [I 11].
  For a local-first, privacy-first project, vendor the WOFF2 files (or use Fontsource) instead
  of adding these packages.
- **Fontsource** packages exist for every Google-hosted candidate, all OFL-1.1: for example
  `@fontsource-variable/commissioner` 5.3.0 and `@fontsource-variable/jetbrains-mono` 5.3.0
  [V 35]. The Fontsource Monaspace and Commit Mono packages carry older upstream versions
  (Monaspace v1.101, without Cyrillic) [V 34], so Monaspace must be vendored from the GitHub
  release.
- **Lucide** is ISC; v1.60.0 was released today [V 14, 41]. No conflict with Apache-2.0.

### 1.3 Pairing quality (judgement) [I]

- **Commissioner + JetBrains Mono.** Both are low-contrast, open-aperture designs with large
  x-heights. Commissioner's humanist proportions soften JetBrains Mono's rectangular rhythm. Set
  the mono at 0.92–0.95 × the proportional size so x-heights align.
- **Commissioner + Iosevka custom.** Works, but Iosevka's 0.5 em advance looks condensed next to
  Commissioner; use Iosevka's Extended width for the code role in this pairing.
- **Iosevka custom + Iosevka Aile.** Same skeleton, so complete harmony. Aile is quasi-proportional
  and reads as "technical document" rather than "consumer app" — the intended voice of a
  mono-first harness.
- **Monaspace Argon (UI) + Neon (code) + Xenon (display).** Metric-compatible, so mixing voices
  never breaks column alignment. Monaspace pitches exactly this for telling authors apart in one
  buffer [20]. For Guanxi it maps naturally to *lead model / executor / human / tool* voices in a
  trace. Long chat prose in a monospace reads more slowly than in a proportional face, so this
  suits the trace and inspector better than chat.
- **Plex Sans + Plex Mono.** Designed as one system; dependable, institutional, recognisably IBM.
- **Onest or Golos + Martian Mono.** The most "Russian-native" look with excellent Cyrillic, but
  neither covers Greek. Acceptable only if Greek leaves the brief.

### 1.4 Recommended pairings

#### Pairing 1 (recommended, proportional + mono): Commissioner + JetBrains Mono

| Role | Face | Settings |
|---|---|---|
| UI text | Commissioner Variable | `wght` 400/500/600, `FLAR 0`, `VOLM 0`; 13–15 px; `font-variant-numeric: tabular-nums` for counters |
| Display / headings | Commissioner Variable | `wght` 300–600, `FLAR 40–100`, `VOLM 0–40`; 24 px and up only (flare reads as noise below that) |
| Mono (code, logs, metrics, IDs) | JetBrains Mono Variable | `wght` 400/600; ligatures **off** by default in logs and diffs (`font-variant-ligatures: none`), optional in the editor |
| Wordmark | Custom-drawn outlines, not a live font | Start from Commissioner lettering at `FLAR ≈ 60`, then hand-adjust to share the logo's 47–49° diagonal |

Why: one variable file per role, no RFN (free subsetting), Latin + Cyrillic + Greek in both faces,
a non-generic proportional voice, and the owner's preferred mono. Weakness: neither face covers
Arabic, Hebrew, Devanagari, Thai or CJK, so fallback quality depends on the stack in §1.5.

#### Pairing 2 (mono-first): Iosevka custom ("Guanxi Mono" / "Guanxi Aile") + Sarasa Gothic

| Role | Face | Settings |
|---|---|---|
| UI chrome, metrics, tables, trace | Guanxi Mono (Iosevka custom, Extended width) | 3 weights (400/500/700); `ss`/`cv` chosen to rhyme with the logo: open single-storey `g`, straight `x` diagonals, slashed or dotted zero |
| Prose (chat, docs) | Guanxi Aile (Iosevka Aile custom, same variants) | 14–15 px, line-height 1.55 |
| Display | Guanxi Mono Heavy, or Commissioner at high `FLAR` | sparingly |
| Terminal CJK | Sarasa Gothic (Mono/Term), user-installed or bundled in the desktop app only | CJK/Latin 2:1 width alignment by design [26] |

Why: unique (nobody else's default); no RFN, so the build can carry Guanxi's own name; the widest
Latin/Greek/Cyrillic coverage of all candidates. Costs: a reproducible Iosevka build (Node ≥ 20 plus
AFDKO and ttfautohint) in CI, and the "terminal" voice is not for everyone.
**Alternative mono-first:** Monaspace (Argon UI, Neon code, Xenon display, one voice per agent).
Less work, but RFN-locked, larger files, and visually GitHub's.

#### Pairing 3 (coverage-first): IBM Plex Sans (variable) + Plex Mono + Plex script companions

Use when "same design in every script" ranks above distinctiveness. Ship the upstream split
WOFF2s, not the npm packages. Distinctiveness must then come entirely from colour and material.

### 1.5 Multi-script fallback stack

Principle: brand faces for Latin, Cyrillic and Greek; operating-system faces next (zero bytes and
the best hinting for that OS); optional downloadable Noto or Plex packs last. Mark up every
message with `lang` so Han unification picks the right regional glyph (関係 / 關係 / 关系) [I].

```css
:root {
  --gx-font-ui: "Commissioner", "gx-fallback-metrics",
    /* Arabic, Hebrew, Devanagari, Thai: OS faces first, then optional packs */
    "SF Arabic", "Geeza Pro", "Segoe UI", "Noto Sans Arabic",
    "SF Hebrew", "Noto Sans Hebrew",
    "Kohinoor Devanagari", "Nirmala UI", "Noto Sans Devanagari",
    "Thonburi", "Leelawadee UI", "Noto Sans Thai",
    system-ui, sans-serif;
  --gx-font-mono: "JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono",
    "DejaVu Sans Mono", monospace;
}
:lang(zh-Hans) { --gx-cjk: "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", "Noto Sans SC"; }
:lang(zh-Hant) { --gx-cjk: "PingFang TC", "Microsoft JhengHei UI", "Noto Sans CJK TC", "Noto Sans TC"; }
:lang(ja)      { --gx-cjk: "Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK JP", "Noto Sans JP"; }
:lang(ko)      { --gx-cjk: "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR"; }
body { font-family: var(--gx-font-ui), var(--gx-cjk, "Noto Sans CJK SC"); }
```

(The CJK variable is shown appended for readability; in production, place the CJK list before
`system-ui` inside `--gx-font-ui` so Latin keeps the brand face and Han characters pick the
`lang`-specific face.)

Optional packs per script. **CJK:** Noto Sans SC/TC/JP/KR (Google serves them as 101–123
unicode-range slices per weight [V 2]); Plex Sans SC/TC/JP under Pairing 3. **Arabic:** Plex Sans
Arabic or Noto Sans Arabic. **Hebrew:** Plex Sans Hebrew or Noto Sans Hebrew. **Devanagari:**
Plex Sans Devanagari or Noto Sans Devanagari. **Thai:** Plex Sans Thai (loopless, modern UI) or
Noto Sans Thai. **Monospace CJK in code blocks:** Sarasa Mono on desktop; elsewhere the browser
falls back glyph by glyph from JetBrains Mono to the CJK face. IBM Plex Sans KR has no Hanja and
cannot render 关系 [V 2].

### 1.6 Loading strategy (Electron and the web client)

1. **Self-host everything; never call a font CDN at runtime** (local-first, offline, no
   third-party request). Put WOFF2 files and each `OFL.txt` under the web package's public fonts
   directory with a `FONTS.md` attribution list.
2. **Subset brand faces into script slices with `unicode-range`**, using the same slices Google
   Fonts serves [V 2]: `latin` (U+0000–00FF, U+0131, U+0152–0153, U+02BB–02BC, U+02C6, U+02DA,
   U+02DC, U+2000–206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD),
   `latin-ext`, `cyrillic` (U+0301, U+0400–045F, U+0490–0491, U+04B0–04B1, U+2116),
   `cyrillic-ext`, `greek` (U+0370–03FF minus unassigned points), `vietnamese`. Tooling:
   `pyftsubset` (fontTools) with `--flavor=woff2 --layout-features='*'` keeps variable axes.
   Expected budget for Pairing 1: Commissioner latin + cyrillic + greek ≈ 120–180 KB, JetBrains
   Mono ≈ 60 KB [I, extrapolated from the [V 2] sizes].
3. **Preload only the two Latin slices** the first screen needs
   (`<link rel="preload" as="font" type="font/woff2" crossorigin>`). Everything else loads on
   demand through `unicode-range`.
4. **`font-display`.** In Electron the files are local, so `block` costs nothing visible. In the
   LAN/mobile web client use `swap` plus a **metric-matched fallback face**
   (`@font-face { font-family: "gx-fallback-metrics"; src: local("Arial"); size-adjust: …;
   ascent-override: …; }`) computed with a tool such as Capsize or fontaine to remove layout
   shift.
5. **CJK: no default bundle.** Desktop relies on preinstalled OS faces (PingFang, Hiragino,
   Microsoft YaHei/JhengHei, Malgun). Linux and the web client get an optional "CJK font pack"
   plugin with sliced Noto Sans CJK WOFF2 (100+ slices; a page fetches only the slices it uses).
   This fits "everything is a plugin" and "light by default".
6. **Brand text 关系** in the lockup and the About screen: outlined SVG paths. Outlines made with a
   font are artwork, not Font Software [I, 40]. If LXGW WenKai or Noto Serif SC is the source,
   credit it in `FONTS.md`.
7. **Per-role user overrides** (text / code / terminal), as DeepSeek Harness does with three
   settings rows that prepend user families to the built-in stack [V 42]. This is also the escape
   hatch for users who need a script the defaults do not cover.

---

## 2. What to avoid — looks overused by AI-generated UIs

| Look | Evidence | Relevance to Guanxi |
|---|---|---|
| Warm cream (≈ `#F4F1EA`) + high-contrast serif display + terracotta (≈ `#D97757`) | Anthropic frontend-design skill, current version [V 6] | **Ivory `#F4F2E9` is ΔE ≈ 0.3 from it.** Never pair ivory with a serif display or a clay/terracotta accent. |
| Near-black + one acid-green or vermilion accent | same source [V 6] | Direction C uses ink `#182322` and two semantic accents (brass, kingfisher) instead. |
| Purple/indigo buttons and blue-violet gradients | Tailwind author's "formally apologize for … `bg-indigo-500`" post [I 43]; Anthropic prompt "purple gradients on white" [V 3] | No high-chroma accent between hue 265° and 310°; plum appears only as data series 5. |
| SaaS card kit: identical rounded cards, one radius everywhere, the same `rgba(0,0,0,.1)` shadow, gradient washes | [V 6] | Radius varies by hierarchy (§3.7); shadows only on floating layers. |
| Template chrome: tracked-out ALL-CAPS eyebrows, "A · B · C" metadata, "WORD — fragment" labels, `→` on every link, **monospace for small data labels** | [V 6] | The current `preview.png` uses tracked-caps eyebrows and mid-dot metadata — fine for a specimen sheet, avoid in product UI. Use mono only for machine-generated values (IDs, hashes, tokens, paths, timings), never as decoration. |
| Inter, Geist (the "new Inter"), Space Grotesk, Instrument Sans/Serif, Fraunces, Mona Sans, Bricolage Grotesque | [V 3] [V 5] [I 39] [I 44] | Excluded. JetBrains Mono and Plex are "rising": acceptable, but not distinctive alone. |
| Generic glassmorphism: violet/blue/cyan blobs behind blurred white cards | [I] widespread; DSH's own onboarding uses "named violet/blue/cyan gradients" [V 42] | Direction B uses glass **without** hue gradients, with grain and an ink seam (§3.4). |
| Staggered fade-and-slide-up on every section; hover lifts on every card | [V 6] | Motion only answers an action; respect `prefers-reduced-motion`. |

---

## 3. Visual identity directions

### 3.1 Logo analysis (inputs to every direction)

- The mark is two filled shapes: an open `g` whose descender sweeps into a long **descending
  diagonal at ≈ 49°** (path from (96,43) to (153,108)), and a detached `x` arm at ≈ 47°
  [V, `logo.svg`]. The diagonal is the "connection"; the gap between arm and diagonal is a
  relation that is not a fusion — the most ownable motif.
- Inner corners are softened with radii of about 2–3 % of the mark's width; the app tile uses
  `rx = 112/512` = 21.9 % [V, `app-icon.svg`].
- Two colours only: ink `oklch(0.245 0.016 189)`, a very dark green-teal; ivory
  `oklch(0.960 0.012 96)`, a faint warm yellow [V-computed]. Ink on ivory: WCAG 14.38:1, APCA
  Lc 95 (ivory on ink Lc −97).

### 3.2 Direction A — "Ink & Paper" (墨与纸)

*Concept:* a connection is a line of ink on paper. The product is the paper, the agents' work is
the ink, and nothing else competes with it.

- **Neutrals:** a deliberate crossfade. The light end carries ivory's warm hue (96°) and the dark
  end carries ink's teal (189°), so greys get greener as they get darker. The light canvas is
  exactly ivory; the dark canvas is exactly ink.
- **Accents:** *verdigris* (oxidised bronze, hue 178° — ink's hue with chroma) for the primary
  action and selection. *Cinnabar* (seal red, hue 30°) appears **only** as the brand seal (a 关系
  chop on the About screen and in exported reports) and as `danger`. It is never a button
  colour, which keeps Direction A out of the cream + terracotta cliché.
- **Type:** Pairing 1. Display uses Commissioner with flare, never a high-contrast serif.
- **Material:** flat paper. Elevation is a tonal step (canvas → step 1) plus a 1 px step-7 rule;
  real shadows appear only on menus and dialogs. Optional paper grain at 2–3 % opacity on the
  canvas only.
- **Risk:** closest to the AI cream look; requires discipline about the two forbidden
  ingredients.

### 3.3 Direction B — "Glacier" (冰川)

*Concept:* models and machines are separate floes; Guanxi is the clear ice that shows all of them
at once and the cold water that connects them.

- **Neutrals:** hue 208° (light) and 218° (dark), with slightly more chroma than A. The light
  canvas is *frost* `#EBF4F5`, not cream. Ink stays the text colour and the app-tile colour.
- **Accents:** *meltwater* blue (hue 238° light / 225° dark) for primary actions; *frost edge*
  (hue 210–215°) for non-text glass highlights only. No second hue: the material carries the
  character. `info` reuses meltwater in this direction.
- **Type:** Pairing 1 (Commissioner at `FLAR 0` everywhere except the hero) or Pairing 2.
- **Material:** frosted glass with grain on floating layers — details in §3.4.
- **Risk:** GPU cost on low-end Linux and Windows machines; needs a measured frame-time budget.

### 3.4 Glacier material recipe and degradation

- **Where:** only **floating** layers — composer, command palette, popovers, the fleet HUD,
  toasts. Never on reading surfaces (chat transcript, code, trace). At most three glass layers
  visible at once, because `backdrop-filter` is GPU-expensive [I].
- **Light glass:** `background: color-mix(in oklch, #F7FCFD 72%, transparent)`;
  `backdrop-filter: blur(20px) saturate(1.15)`. **Ice edge:** `inset 0 1px 0 oklch(1 0 0 / .65)`.
  **Ink seam:** a 1 px bottom border `oklch(0.245 0.016 189 / .10)`. **Grain:** a static 128 px
  tiled `feTurbulence` SVG data URI at 4–6 % opacity with `mix-blend-mode: soft-light`; no
  animated noise.
- **Dark glass:** `color-mix(in oklch, #1C2A2E 70%, transparent)`, same blur, edge
  `oklch(1 0 0 / .08)`, grain 5–7 %.
- **Worst-case contrast with glass composited over unfavourable content [V-computed]:**

  | Glass over | Composite | Text | WCAG | APCA Lc |
  |---|---|---|---|---|
  | light glass over B light canvas | `#F4FAFB` | ink `#182322` | 15.29 | 99 |
  | light glass over a sky-blue chart area `#7BC4DB` | `#D4ECF3` | ink | 13.12 | 89 |
  | light glass over pure ink content | `#B9BFC0` | ink | 8.66 | 66 |
  | dark glass over B dark canvas | `#1A282C` | frost `#EEF5F6` | 13.75 | −97 |
  | dark glass over meltwater `#75CBEC` | `#375A67` | frost | 6.75 | −83 |
  | dark glass over frost-white content | `#5B676A` | frost | 5.30 | −77 |

  All pass WCAG AA for body text. Lc 66 is below APCA's Lc 75 body-text preference, which is why
  glass never hosts long reading text.
- **Graceful degradation.** Under `@media (prefers-reduced-transparency: reduce)` use a solid
  step-1 fill, no blur, no grain, and a 1 px step-8 border instead of the edge. Chromium supports
  the query since version 118 (Electron 44 ships Chromium 152); Safari does not; Firefox only
  behind a flag [V 45]. The Electron main process therefore also mirrors
  `nativeTheme.prefersReducedTransparency` — cross-platform, added in Electron 30.4/31.4, and the
  replacement for the deprecated macOS-only
  `systemPreferences.accessibilityDisplayShouldReduceTransparency` [V 46] — into a
  `data-reduce-transparency` attribute, which also covers WebKit-based mobile shells. The same
  solid fallback applies under `prefers-contrast: more`, `forced-colors: active`, battery saver,
  and when GPU compositing is disabled.
- **How this differs from DeepSeek Harness.** DSH's material is native macOS vibrancy behind
  menus, 0.5 px hairlines on every flat border, no blur on modal masks, a superellipse corner
  shape, Montserrat brand text, and violet/blue/cyan onboarding gradients [V 42]. Guanxi B adds
  grain, an ice edge with an ink seam, 1 px rules, no hue gradients, and teal-ink text.

### 3.5 Direction C — "Loom" (经纬)

*Concept:* a harness is a loom. Warp threads are machines, weft threads are models, and every run
is a visible crossing of the two.

- **Neutrals:** a single hue (189°, ink) at very low chroma. The light canvas is a cool, faintly
  green paper `#EDF3F3`; the dark canvas is ink.
- **Accents:** *brass* (hue 80–85°) marks live activity — running jobs, leases, streaming.
  *Kingfisher* (hue 222°) marks links and selection. Two accents with clear semantic jobs, not a
  single neon on black. Because brass and `warning` are close in hue, warnings in C always carry
  an icon and label; alternatively shift C's warning to hue 55°.
- **Type:** Pairing 2 (mono-first), or Monaspace with one voice per actor; numbers always tabular.
- **Material:** no shadows. Structure comes from 1 px rules on a 4 px grid. The logo's 45–49°
  diagonal appears **only** as the connector glyph between a plan step and the model or machine
  that ran it (trace view, fleet map). High density; compact mode by default for logs.
- **Risk:** reads as a developer tool first, which is less welcoming to the tertiary "just make an
  image" user unless the empty session stays as simple as the vision requires.

### 3.6 Colour systems — computed values

Ramp convention (Radix-style 12 steps): 1 raised surface; 2 canvas; 3–5 component fills (rest,
hover, pressed); 6–8 borders (7 = decorative divider, below 3:1 by design); 9 control border
(≥ 3:1, WCAG 1.4.11); 10 muted text (≥ 4.5:1); 11 secondary text (≥ 7:1); 12 primary text.
Accent and semantic rows show the colour as text or icon on the canvas; the last column shows the
canvas-coloured text on a filled badge or button of that colour. "(clipped)" means chroma was
reduced to fit sRGB: treat the hex as the source of truth and the OKLCH as the P3 target.
APCA thresholds (Lc ≥ 75 body text, ≥ 60 for 16 px+ non-body text, ≥ 45 large/bold text and UI
glyphs) are advisory; APCA is not part of WCAG 2.2 conformance. Dark-theme muted text sits at
Lc −54/−55, so use it at 14 px+ medium weight, not for body copy.

#### Direction A — neutral ramp

| Step | Light OKLCH | Light hex | Dark OKLCH | Dark hex |
|---|---|---|---|---|
| 1 | `oklch(0.985 0.012 96)` | `#FCFAF1` | `oklch(0.205 0.016 189)` | `#0F1A19` |
| 2 | `oklch(0.960 0.012 96)` | `#F4F2E9` | `oklch(0.245 0.016 189)` | `#182322` |
| 3 | `oklch(0.935 0.012 102)` | `#EBEAE1` | `oklch(0.275 0.016 189)` | `#1F2A29` |
| 4 | `oklch(0.910 0.012 105)` | `#E2E2D9` | `oklch(0.300 0.016 189)` | `#25302F` |
| 5 | `oklch(0.885 0.012 109)` | `#D9DAD1` | `oklch(0.330 0.016 189)` | `#2C3837` |
| 6 | `oklch(0.855 0.013 112)` | `#CFD0C7` | `oklch(0.360 0.016 189)` | `#34403F` |
| 7 | `oklch(0.800 0.013 119)` | `#BCBFB6` | `oklch(0.410 0.016 189)` | `#414D4C` |
| 8 | `oklch(0.700 0.013 132)` | `#9BA098` | `oklch(0.480 0.016 189)` | `#54615F` |
| 9 | `oklch(0.600 0.014 144)` | `#7B827B` | `oklch(0.600 0.011 189)` | `#798281` |
| 10 | `oklch(0.530 0.014 153)` | `#666E68` | `oklch(0.740 0.011 189)` | `#A3ADAC` |
| 11 | `oklch(0.420 0.015 167)` | `#46504B` | `oklch(0.840 0.011 189)` | `#C3CDCC` |
| 12 | `oklch(0.245 0.016 189)` | `#182322` | `oklch(0.960 0.012 96)` | `#F4F2E9` |

**Light theme** (canvas `#F4F2E9`):

| Role | OKLCH | hex | WCAG 2.2 vs canvas | APCA Lc vs canvas | Text on this fill (WCAG / Lc) |
|---|---|---|---|---|---|
| text-primary (12) on canvas | `oklch(0.245 0.016 189)` | `#182322` | 14.38 | 95 | — |
| text-secondary (11) on canvas | `oklch(0.420 0.015 167)` | `#46504B` | 7.46 | 81 | — |
| text-muted (10) on canvas | `oklch(0.530 0.014 153)` | `#666E68` | 4.69 | 68 | — |
| control border (9) on canvas | `oklch(0.600 0.014 144)` | `#7B827B` | 3.52 | 59 | — |
| divider (7) on canvas | `oklch(0.800 0.013 119)` | `#BCBFB6` | 1.66 | 27 | — |
| text-primary (12) on raised surface | `oklch(0.245 0.016 189)` | `#182322` | 15.42 | 100 | — |
| accent (verdigris) | `oklch(0.500 0.085 178)` | `#187363` | 5.10 | 70 | `#F4F2E9` 5.10 / Lc -75 |
| seal (cinnabar) | `oklch(0.530 0.165 30)` | `#B83A2B` | 5.09 | 70 | `#F4F2E9` 5.09 / Lc -74 |
| success | `oklch(0.500 0.110 150)` | `#2B7440` | 5.10 | 70 | `#F4F2E9` 5.10 / Lc -75 |
| warning | `oklch(0.520 0.110 68)` | `#925B0C` | 5.03 | 70 | `#F4F2E9` 5.03 / Lc -74 |
| danger | `oklch(0.530 0.170 28)` | `#BA362E` | 5.12 | 70 | `#F4F2E9` 5.12 / Lc -74 |
| info | `oklch(0.500 0.100 242)` | `#236997` | 5.29 | 71 | `#F4F2E9` 5.29 / Lc -76 |

**Dark theme** (canvas `#182322`):

| Role | OKLCH | hex | WCAG 2.2 vs canvas | APCA Lc vs canvas | Text on this fill (WCAG / Lc) |
|---|---|---|---|---|---|
| text-primary (12) on canvas | `oklch(0.960 0.012 96)` | `#F4F2E9` | 14.38 | -97 | — |
| text-secondary (11) on canvas | `oklch(0.840 0.011 189)` | `#C3CDCC` | 9.92 | -73 | — |
| text-muted (10) on canvas | `oklch(0.740 0.011 189)` | `#A3ADAC` | 7.01 | -54 | — |
| control border (9) on canvas | `oklch(0.600 0.011 189)` | `#798281` | 4.09 | -33 | — |
| divider (7) on canvas | `oklch(0.410 0.016 189)` | `#414D4C` | 1.84 | -10 | — |
| text-primary (12) on raised surface | `oklch(0.960 0.012 96)` | `#F4F2E9` | 13.17 | -96 | — |
| accent (verdigris) | `oklch(0.780 0.085 178)` | `#78CAB7` | 8.39 | -64 | `#182322` 8.39 / Lc 64 |
| seal (cinnabar) | `oklch(0.760 0.130 30)` | `#F8907F` | 7.13 | -56 | `#182322` 7.13 / Lc 57 |
| success | `oklch(0.780 0.120 150)` | `#7CCD8E` | 8.43 | -64 | `#182322` 8.43 / Lc 65 |
| warning | `oklch(0.820 0.130 80)` | `#F0BA59` | 9.12 | -68 | `#182322` 9.12 / Lc 69 |
| danger | `oklch(0.760 0.140 28)` | `#FD8C7E` | 7.09 | -55 | `#182322` 7.09 / Lc 57 |
| info | `oklch(0.780 0.090 242)` | `#83BFEC` | 8.16 | -62 | `#182322` 8.16 / Lc 63 |

#### Direction B — neutral ramp

| Step | Light OKLCH | Light hex | Dark OKLCH | Dark hex |
|---|---|---|---|---|
| 1 | `oklch(0.985 0.010 208)` | `#F3FCFE` | `oklch(0.205 0.020 218)` | `#0C191D` |
| 2 | `oklch(0.960 0.010 208)` | `#EBF4F5` | `oklch(0.245 0.020 218)` | `#152327` |
| 3 | `oklch(0.935 0.010 208)` | `#E2EBED` | `oklch(0.275 0.020 218)` | `#1C2A2E` |
| 4 | `oklch(0.910 0.010 208)` | `#DAE3E5` | `oklch(0.300 0.020 218)` | `#233035` |
| 5 | `oklch(0.885 0.015 208)` | `#CEDCDE` | `oklch(0.330 0.020 218)` | `#2A383C` |
| 6 | `oklch(0.855 0.015 208)` | `#C5D2D4` | `oklch(0.360 0.020 218)` | `#324044` |
| 7 | `oklch(0.800 0.015 208)` | `#B3C1C3` | `oklch(0.410 0.020 218)` | `#3F4D52` |
| 8 | `oklch(0.700 0.015 208)` | `#94A1A3` | `oklch(0.480 0.020 218)` | `#516165` |
| 9 | `oklch(0.600 0.015 208)` | `#768385` | `oklch(0.600 0.013 218)` | `#788285` |
| 10 | `oklch(0.530 0.015 208)` | `#626E70` | `oklch(0.740 0.013 218)` | `#A2ADB0` |
| 11 | `oklch(0.420 0.015 208)` | `#445051` | `oklch(0.840 0.013 218)` | `#C2CDD0` |
| 12 | `oklch(0.245 0.016 189)` | `#182322` | `oklch(0.965 0.008 205)` | `#EEF5F6` |

**Light theme** (canvas `#EBF4F5`):

| Role | OKLCH | hex | WCAG 2.2 vs canvas | APCA Lc vs canvas | Text on this fill (WCAG / Lc) |
|---|---|---|---|---|---|
| text-primary (12) on canvas | `oklch(0.245 0.016 189)` | `#182322` | 14.43 | 95 | — |
| text-secondary (11) on canvas | `oklch(0.420 0.015 208)` | `#445051` | 7.48 | 81 | — |
| text-muted (10) on canvas | `oklch(0.530 0.015 208)` | `#626E70` | 4.72 | 69 | — |
| control border (9) on canvas | `oklch(0.600 0.015 208)` | `#768385` | 3.51 | 59 | — |
| divider (7) on canvas | `oklch(0.800 0.015 208)` | `#B3C1C3` | 1.66 | 27 | — |
| text-primary (12) on raised surface | `oklch(0.245 0.016 189)` | `#182322` | 15.48 | 100 | — |
| accent (meltwater) | `oklch(0.500 0.115 238)` | `#036B9A` (clipped) | 5.26 | 71 | `#F3FCFE` 5.64 / Lc -81 |
| frost edge (non-text only) | `oklch(0.620 0.070 215)` | `#5191A1` | 3.18 | 55 | — |
| success | `oklch(0.500 0.110 150)` | `#2B7440` | 5.11 | 71 | `#F3FCFE` 5.49 / Lc -80 |
| warning | `oklch(0.520 0.110 68)` | `#925B0C` | 5.05 | 70 | `#F3FCFE` 5.42 / Lc -80 |
| danger | `oklch(0.530 0.170 28)` | `#BA362E` | 5.14 | 70 | `#F3FCFE` 5.52 / Lc -80 |
| info | `oklch(0.500 0.100 242)` | `#236997` | 5.31 | 72 | `#F3FCFE` 5.70 / Lc -81 |

**Dark theme** (canvas `#152327`):

| Role | OKLCH | hex | WCAG 2.2 vs canvas | APCA Lc vs canvas | Text on this fill (WCAG / Lc) |
|---|---|---|---|---|---|
| text-primary (12) on canvas | `oklch(0.965 0.008 205)` | `#EEF5F6` | 14.62 | -98 | — |
| text-secondary (11) on canvas | `oklch(0.840 0.013 218)` | `#C2CDD0` | 9.94 | -73 | — |
| text-muted (10) on canvas | `oklch(0.740 0.013 218)` | `#A2ADB0` | 7.02 | -54 | — |
| control border (9) on canvas | `oklch(0.600 0.013 218)` | `#788285` | 4.10 | -33 | — |
| divider (7) on canvas | `oklch(0.410 0.020 218)` | `#3F4D52` | 1.84 | -10 | — |
| text-primary (12) on raised surface | `oklch(0.965 0.008 205)` | `#EEF5F6` | 13.40 | -97 | — |
| accent (meltwater) | `oklch(0.800 0.095 225)` | `#75CBEC` | 8.84 | -66 | `#182322` 8.84 / Lc 67 |
| frost edge (non-text only) | `oklch(0.880 0.045 210)` | `#B6E0E8` | 11.38 | -81 | — |
| success | `oklch(0.780 0.120 150)` | `#7CCD8E` | 8.44 | -64 | `#182322` 8.43 / Lc 65 |
| warning | `oklch(0.820 0.130 80)` | `#F0BA59` | 9.12 | -68 | `#182322` 9.12 / Lc 69 |
| danger | `oklch(0.760 0.140 28)` | `#FD8C7E` | 7.09 | -55 | `#182322` 7.09 / Lc 57 |
| info | `oklch(0.780 0.090 242)` | `#83BFEC` | 8.17 | -62 | `#182322` 8.16 / Lc 63 |

#### Direction C — neutral ramp

| Step | Light OKLCH | Light hex | Dark OKLCH | Dark hex |
|---|---|---|---|---|
| 1 | `oklch(0.985 0.007 189)` | `#F5FCFB` | `oklch(0.205 0.016 189)` | `#0F1A19` |
| 2 | `oklch(0.960 0.007 189)` | `#EDF3F3` | `oklch(0.245 0.016 189)` | `#182322` |
| 3 | `oklch(0.935 0.007 189)` | `#E5EBEA` | `oklch(0.275 0.016 189)` | `#1F2A29` |
| 4 | `oklch(0.910 0.007 189)` | `#DCE3E2` | `oklch(0.300 0.016 189)` | `#25302F` |
| 5 | `oklch(0.885 0.016 189)` | `#CEDDDB` | `oklch(0.330 0.016 189)` | `#2C3837` |
| 6 | `oklch(0.855 0.016 189)` | `#C5D3D1` | `oklch(0.360 0.016 189)` | `#34403F` |
| 7 | `oklch(0.800 0.016 189)` | `#B3C1C0` | `oklch(0.410 0.016 189)` | `#414D4C` |
| 8 | `oklch(0.700 0.016 189)` | `#94A2A0` | `oklch(0.480 0.016 189)` | `#54615F` |
| 9 | `oklch(0.600 0.016 189)` | `#768382` | `oklch(0.600 0.010 189)` | `#7A8281` |
| 10 | `oklch(0.530 0.016 189)` | `#626F6D` | `oklch(0.740 0.010 189)` | `#A4ADAC` |
| 11 | `oklch(0.420 0.016 189)` | `#44504F` | `oklch(0.840 0.010 189)` | `#C4CDCC` |
| 12 | `oklch(0.245 0.016 189)` | `#182322` | `oklch(0.955 0.007 189)` | `#EBF2F1` |

**Light theme** (canvas `#EDF3F3`):

| Role | OKLCH | hex | WCAG 2.2 vs canvas | APCA Lc vs canvas | Text on this fill (WCAG / Lc) |
|---|---|---|---|---|---|
| text-primary (12) on canvas | `oklch(0.245 0.016 189)` | `#182322` | 14.37 | 95 | — |
| text-secondary (11) on canvas | `oklch(0.420 0.016 189)` | `#44504F` | 7.47 | 81 | — |
| text-muted (10) on canvas | `oklch(0.530 0.016 189)` | `#626F6D` | 4.66 | 68 | — |
| control border (9) on canvas | `oklch(0.600 0.016 189)` | `#768382` | 3.51 | 59 | — |
| divider (7) on canvas | `oklch(0.800 0.016 189)` | `#B3C1C0` | 1.66 | 27 | — |
| text-primary (12) on raised surface | `oklch(0.245 0.016 189)` | `#182322` | 15.51 | 100 | — |
| accent (brass) | `oklch(0.500 0.095 80)` | `#7F5C15` | 5.43 | 72 | `#F4F2E9` 5.44 / Lc -77 |
| link (kingfisher) | `oklch(0.500 0.100 222)` | `#026E89` (clipped) | 5.21 | 71 | `#F4F2E9` 5.21 / Lc -75 |
| success | `oklch(0.500 0.110 150)` | `#2B7440` | 5.09 | 70 | `#F4F2E9` 5.10 / Lc -75 |
| warning | `oklch(0.520 0.110 68)` | `#925B0C` | 5.03 | 70 | `#F4F2E9` 5.03 / Lc -74 |
| danger | `oklch(0.530 0.170 28)` | `#BA362E` | 5.12 | 70 | `#F4F2E9` 5.12 / Lc -74 |
| info | `oklch(0.500 0.100 242)` | `#236997` | 5.29 | 71 | `#F4F2E9` 5.29 / Lc -76 |

**Dark theme** (canvas `#182322`):

| Role | OKLCH | hex | WCAG 2.2 vs canvas | APCA Lc vs canvas | Text on this fill (WCAG / Lc) |
|---|---|---|---|---|---|
| text-primary (12) on canvas | `oklch(0.955 0.007 189)` | `#EBF2F1` | 14.21 | -96 | — |
| text-secondary (11) on canvas | `oklch(0.840 0.010 189)` | `#C4CDCC` | 9.94 | -73 | — |
| text-muted (10) on canvas | `oklch(0.740 0.010 189)` | `#A4ADAC` | 7.03 | -55 | — |
| control border (9) on canvas | `oklch(0.600 0.010 189)` | `#7A8281` | 4.10 | -33 | — |
| divider (7) on canvas | `oklch(0.410 0.016 189)` | `#414D4C` | 1.84 | -10 | — |
| text-primary (12) on raised surface | `oklch(0.955 0.007 189)` | `#EBF2F1` | 13.02 | -95 | — |
| accent (brass) | `oklch(0.800 0.125 85)` | `#E3B756` | 8.58 | -65 | `#182322` 8.58 / Lc 65 |
| link (kingfisher) | `oklch(0.780 0.090 222)` | `#72C5E1` | 8.28 | -63 | `#182322` 8.28 / Lc 64 |
| success | `oklch(0.780 0.120 150)` | `#7CCD8E` | 8.43 | -64 | `#182322` 8.43 / Lc 65 |
| warning | `oklch(0.820 0.130 80)` | `#F0BA59` | 9.12 | -68 | `#182322` 9.12 / Lc 69 |
| danger | `oklch(0.760 0.140 28)` | `#FD8C7E` | 7.09 | -55 | `#182322` 7.09 / Lc 57 |
| info | `oklch(0.780 0.090 242)` | `#83BFEC` | 8.16 | -62 | `#182322` 8.16 / Lc 63 |

Notes on the tables. In Direction A the dark `danger` and `seal` are deliberately almost the same
cinnabar; the seal is never interactive, so the two meanings cannot collide. Light-theme
semantic colours are shared across directions so that status meaning never changes with a theme
switch; only canvas-coloured text on fills differs. Direction B's dark canvas `#152327` is ink
shifted 29° towards blue; if the owner prefers the exact brand ink there too, Direction A/C's
dark ramp can be reused unchanged.

#### Data-visualisation categorical scale (shared by all directions)

Constraints: each colour ≥ 3:1 against its canvas (WCAG 1.4.11 graphical objects), no indigo or
violet, slot 1 is the brand ink-teal, and lightness alternates so series stay separable under
colour-vision deficiency. Use slots in order; beyond six series, switch to direct labels plus
dash patterns or small multiples.

| Slot | Name | Light theme (on `#F4F2E9`) | WCAG | Dark theme (on `#182322`) | WCAG |
|---|---|---|---|---|---|
| 1 | ink-teal | `oklch(0.50 0.09 195)` `#017272` | 5.13 | `oklch(0.74 0.09 192)` `#5EBDB9` | 7.26 |
| 2 | ochre | `oklch(0.64 0.15 62)` `#CA7401` | 3.12 | `oklch(0.80 0.14 75)` `#F2AF48` | 8.45 |
| 3 | cobalt | `oklch(0.44 0.14 258)` `#174F9E` | 7.07 | `oklch(0.66 0.13 255)` `#5894E0` | 5.17 |
| 4 | cinnabar | `oklch(0.57 0.18 28)` `#CC3E35` | 4.35 | `oklch(0.68 0.17 30)` `#EF6856` | 5.21 |
| 5 | plum | `oklch(0.40 0.11 340)` `#6D2C5A` | 8.68 | `oklch(0.82 0.10 345)` `#F3AAD3` | 8.83 |
| 6 | moss | `oklch(0.62 0.14 138)` `#599940` | 3.09 | `oklch(0.62 0.14 140)` `#549A44` | 4.67 |
| 7 | umber | `oklch(0.52 0.09 85)` `#816422` | 4.95 | `oklch(0.90 0.10 100)` `#EDE091` | 12.03 |
| 8 | slate | `oklch(0.61 0.05 240)` `#68889F` | 3.34 | `oklch(0.62 0.04 230)` `#6E8B9A` | 4.47 |

Minimum pairwise OKLab distance ×100 [V-computed] (for reference, ≈ 2 is a just-noticeable
difference; ≥ 10 is comfortable):

| Set | Normal | Protan | Deutan | Tritan |
|---|---|---|---|---|
| Light, slots 1–6 | 12.3 | 5.6 | 3.9 (cinnabar/moss) | 6.3 |
| Light, slots 1–8 | 12.3 | 3.8 | 3.9 | 2.8 |
| Dark, slots 1–6 | 14.5 | 3.8 (ink-teal/plum) | 7.3 | 4.2 |
| Dark, slots 1–8 | 10.3 | 3.8 | 7.3 | 3.2 |

Honest limit: no eight-colour palette that also meets 3:1 on a light canvas and avoids violet
separates every pair for deuteranopes. Rule: never let slots 4 and 6 be the only difference
between two series; in multi-model charts assign colours to models stably (same model, same
colour everywhere) and always label lines directly.

### 3.7 Radius, spacing, elevation

| Token | A Ink & Paper | B Glacier | C Loom |
|---|---|---|---|
| Base grid | 4 px | 4 px | 4 px (dense: 2 px sub-steps in tables) |
| Spacing scale | 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64 | same | same, compact default |
| Radius — inline (chips, tags, kbd) | 4 | 6 | 2 |
| Radius — controls (button, input) | 6 | 10 | 4 |
| Radius — panels, cards | 10 | 16 | 6 |
| Radius — sheets, dialogs, glass layers | 14 | 20 | 8 |
| Radius — app tile | 21.9 % (from `app-icon.svg`) | 21.9 % | 21.9 % |
| Elevation 0 (canvas) | step 2 | step 2 | step 2 |
| Elevation 1 (raised) | step 1 + 1 px step-7 rule, no shadow | step 1 + 1 px rule | step 1 + 1 px step-7 rule |
| Elevation 2 (popover) | `0 1px 2px ink/.06, 0 6px 16px ink/.08` | glass + `0 1px 2px ink/.08, 0 8px 24px ink/.10` | 1 px step-9 border, no shadow |
| Elevation 3 (dialog) | `0 2px 4px ink/.08, 0 16px 40px ink/.12` + scrim ink/.40 | glass-strong + scrim ink/.32, no blur on scrim | 1 px step-9 border + scrim ink/.50 |
| Focus ring | 2 px accent + 2 px canvas offset | 2 px meltwater + 2 px offset | 2 px kingfisher + 2 px offset |

Radii vary by hierarchy on purpose (the "one radius everywhere" kit is a tell [6]). Shadows use
ink, never pure black, so they read as part of the palette.

### 3.8 Iconography — fit with Lucide

Lucide's rules: 24 × 24 grid, 1 px padding, 2 px centred strokes, round caps and joins, 2 px
radius on 90° corners of shapes ≥ 8 px, 2 px minimum gaps [V 47]. Fit with the gx mark [I]:

- The mark is **filled** with crisp 45–49° diagonals; Lucide is **stroked** with round caps. The
  two coexist if the logo is never placed in an icon slot and icons never imitate the logo.
- At UI sizes use `size={18|20}` with `strokeWidth={1.75}` and `absoluteStrokeWidth`, which
  matches Commissioner/JetBrains Mono at weight 400–500 better than the 2 px default [I].
- Draw 4–6 **Guanxi-specific icons** on Lucide's grid and rules — connection/relay (two nodes
  joined by a 45° line with a gap, quoting the detached arm), fleet machine, lease, hibernating
  lead, judge — and contribute generic ones upstream when useful.
- Direction C may use Lucide at `strokeWidth={1.5}` for density; Direction B keeps 1.75 so icons
  hold up on glass.

### 3.9 Logo usage rules

- **Clear space:** one *arm unit* on every side — the height of the detached `x` arm, which is
  49/153 ≈ 0.32 of the symbol height [V, `logo.svg` geometry]. In a lockup, the same unit
  separates symbol and wordmark.
- **Minimum size:** primary symbol 20 px tall on screen, 6 mm in print. Below 32 px use
  `favicon.svg`, whose upper arm has a wider gap [V, README]. Never render the primary mark
  smaller than 16 px.
- **On light surfaces:** ink symbol on any step 1–4 surface of any direction. **On dark
  surfaces:** ivory symbol (`logo-inverse.svg`) on ink or any dark step 1–5. Do not use the
  frost-white of Direction B for the mark — the mark's ivory is a fixed brand colour.
- **On glass:** only the ink symbol on light glass, or ivory on dark glass, and only if the
  composite behind it stays within the light or dark ramp's steps 1–5 (≥ 7:1 against the mark).
  Over busy content, place the mark on the solid app tile instead.
- **Never:** recolour the mark with an accent; add gradients, glow or outline; rotate; close the
  gap between arm and diagonal; set a live-font "Guanxi" next to it in production (the current
  wordmark is a system-font preview [V, README] — commission or draw an outlined wordmark).
- **Seal variant (Direction A only):** 关系 in outlined Kai or Song style inside a cinnabar
  square, used as a mark of authorship on exported reports, never as the app icon.

---

## 4. Decisions the owner must make

1. **Typography route:** Pairing 1 (Commissioner + JetBrains Mono, recommended), Pairing 2
   (custom Iosevka mono-first, most distinctive, requires a build pipeline), or Pairing 3 (Plex,
   widest designed-together script coverage, least distinctive).
2. **Is Greek a hard requirement?** If not, Onest or Golos + Martian Mono become available
   (stronger Russian-native character).
3. **Ivory's role:** UI canvas (Direction A, with the serif and terracotta ban) or brand-mark
   colour only (Directions B and C).
4. **Direction:** A Ink & Paper, B Glacier (closest to the owner's stated taste), or C Loom; or
   B for floating layers on top of C's structure.
5. **CJK policy:** OS faces + optional pack (recommended), or bundle Noto Sans SC in the desktop
   app (≈ 4–18 MB). And which form of 关系 to show — Simplified (关系), Traditional (關係), or
   both.
6. **Wordmark:** commission or draw an outlined "Guanxi" wordmark (the current one is
   preview-only typography).

Residual risks: Commissioner and Monaspace hinting on 96-dpi Windows is untested; glass
performance on low-end GPUs is unmeasured; CVD separation of the categorical scale is computed,
not user-tested; the "slop risk" column relies on prompts, a community issue and blog posts,
not on a measured corpus.

---

## Sources

All accessed 2026-10-20.

1. Google Fonts family metadata JSON — <https://fonts.google.com/metadata/fonts> (subsets, axes,
   dates, popularity, family TTF size).
2. Google Fonts CSS2 API responses and HEAD `Content-Length` of referenced WOFF2 files —
   <https://fonts.googleapis.com/css2?family=…> (JetBrains Mono, IBM Plex Sans/Mono/JP/KR, Onest,
   Golos Text, Martian Mono, Inter, Mona Sans, Noto Sans SC/TC/JP, LXGW WenKai TC).
3. Anthropic, "Prompting for frontend aesthetics" cookbook —
   <https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics> ; earlier
   `frontend-design` SKILL.md (commit 0075614, 2025-12-04) —
   <https://github.com/anthropics/skills/blob/00756142ab04c82a447693cf373c4e0c554d1005/skills/frontend-design/SKILL.md>
4. Search-result summary noting `--font-jetbrains` in claude.ai CSS —
   <https://assets-proxy.anthropic.com/claude-ai/v1/_next/static/css/1bdb36932a6d7a0b.css>
   (not opened directly; [I]).
5. mgiovani/stopslop issue #89 "design: typography defaults" (opened 2026-10-14, MIT, 3 stars —
   weak signal) — <https://github.com/mgiovani/stopslop/issues/89>
6. Anthropic `frontend-design` SKILL.md, current version (last commit 2026-09-03) —
   <https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md>
7. kosbarts/Commissioner README and OFL.txt — <https://github.com/kosbarts/Commissioner>
8. JetBrains Mono site ("148 languages supported", OFL) — <https://www.jetbrains.com/lp/mono/>
9. be5invis/Iosevka README (248 supported languages; character variants) —
   <https://github.com/be5invis/Iosevka>
10. IBM/plex README (scripts supported) — <https://github.com/IBM/plex>
11. ibm-telemetry/telemetry-js README — <https://github.com/ibm-telemetry/telemetry-js>
12. IBM/plex `packages/plex-sans/package.json` and `telemetry.yml` —
    <https://github.com/IBM/plex/tree/master/packages/plex-sans>
13. JetBrains/JetBrainsMono README and OFL.txt — <https://github.com/JetBrains/JetBrainsMono>
14. GitHub REST API `repos/{owner}/{repo}` and `releases/latest` for JetBrains/JetBrainsMono,
    IBM/plex, githubnext/monaspace, eigilnikolajsen/commit-mono, be5invis/Iosevka,
    be5invis/Sarasa-Gothic, arrowtype/recursive, github/mona-sans, github/hubot-sans,
    evilmartians/mono, lxgw/LxgwWenKai, adobe-fonts/source-han-sans, notofonts/noto-cjk,
    lucide-icons/lucide, kosbarts/Commissioner.
15. IBM/plex LICENSE.txt (RFN "Plex"); google/fonts `ofl/notosanssc/OFL.txt` (RFN "Source") —
    <https://github.com/IBM/plex/blob/master/LICENSE.txt> ;
    <https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt>
16. IBM/plex release notes: `@ibm/plex-sans-variable@0.2.0`, `@ibm/plex-sans-sc@1.1.0`,
    `@ibm/plex-mono@2.5.0`, `@ibm/plex-mono-variable@1.0.0`; package READMEs —
    <https://github.com/IBM/plex/releases>
17. IBM/plex git tree (WOFF2 blob sizes for plex-sans-variable and plex-sans-sc) —
    <https://github.com/IBM/plex/tree/master/packages>
18. githubnext/monaspace LICENSE (RFN "Monaspace", Argon, Neon, Xenon, Radon, Krypton) —
    <https://github.com/githubnext/monaspace/blob/main/LICENSE>
19. githubnext/monaspace releases v1.200–v1.400 —
    <https://github.com/githubnext/monaspace/releases>
20. Monaspace site (axes, voices, texture healing) — <https://monaspace.githubnext.com/>
21. githubnext/monaspace git tree, `fonts/Web Fonts/Variable Web Fonts/*.woff2` sizes.
22. eigilnikolajsen/commit-mono LICENSE (MIT, site) and LICENSE-FONT (OFL) —
    <https://github.com/eigilnikolajsen/commit-mono>
23. Commit Mono site — <https://commitmono.com/>
24. be5invis/Iosevka LICENSE.md — <https://github.com/be5invis/Iosevka/blob/main/LICENSE.md>
25. be5invis/Iosevka release v34.9.0 assets — <https://github.com/be5invis/Iosevka/releases>
26. be5invis/Sarasa-Gothic README and LICENSE — <https://github.com/be5invis/Sarasa-Gothic>
27. be5invis/Sarasa-Gothic release v1.0.42 assets —
    <https://github.com/be5invis/Sarasa-Gothic/releases>
28. arrowtype/recursive README (language support, axes) — <https://github.com/arrowtype/recursive>
29. github/mona-sans README (variable axes) — <https://github.com/github/mona-sans>
30. google/fonts `ofl/onest/METADATA.pb`, `ofl/onest/OFL.txt`, `ofl/golostext/OFL.txt`;
    googlefonts/golos-text README — <https://github.com/google/fonts/tree/main/ofl/onest> ;
    <https://github.com/googlefonts/golos-text>
31. ParaType post on Golos Text and Golos UI under OFL (via search result) —
    <https://twitter.com/ParaTypeNews/status/1352600367876472832> ([I]; paratype.com page did not
    render).
32. evilmartians/mono OFL.txt — <https://github.com/evilmartians/mono/blob/main/OFL.txt>
33. evilmartians/mono README (hinting, widths) — <https://github.com/evilmartians/mono>
34. Fontsource API — <https://api.fontsource.org/v1/fonts/{id}> (commissioner, monaspace-argon,
    commit-mono, iosevka, etc.); kosbarts/Commissioner git tree (variable TTF size).
35. npm registry `npm view` for `@fontsource-variable/*`, `@fontsource/*`, `@ibm/plex-sans-sc`.
36. U.S. Graphics catalog FX-102 Berkeley Mono Developer (page returned HTTP 403 to the fetcher;
    terms from search-result summaries and black-atom-industries/black-atom issue #49) —
    <https://usgraphics.com/catalog/FX-102> ;
    <https://github.com/black-atom-industries/black-atom/issues/49> ([I]).
37. adobe-fonts/source-han-sans LICENSE.txt and release 2.005R —
    <https://github.com/adobe-fonts/source-han-sans>
38. lxgw/LxgwWenKai README (coverage, RFN, web-subsetting exception) —
    <https://github.com/lxgw/LxgwWenKai>
39. Sailop blog, "Geist Is the New Inter" (method not stated; [I]) —
    <https://sailop.com/blog/geist-the-new-inter-ai-font-fingerprint-2026> ; Fontlark, "Why
    vibe-coded apps keep using the same fonts" — <https://fontlark.com/fonts-vibe-coded-apps-use/>
40. SIL OFL FAQ (items 1.12, 1.20–1.21, 2.2–2.9) — <https://openfontlicense.org/ofl-faq/>
41. lucide-icons/lucide LICENSE (ISC) — <https://github.com/lucide-icons/lucide/blob/main/LICENSE>
42. deepseek-ai/deepseek-harness `docs/web-styling.md` and
    `packages/client/ui-theme/README.md` (MIT) — <https://github.com/deepseek-ai/deepseek-harness>
43. Adam Wathan post on `bg-indigo-500` (2025-08-07; via search result) —
    <https://x.com/adamwathan/status/1953510802159219096> ([I]).
44. @pauline_makes post on fonts becoming "AI slop coded" (2026-08; via search result) —
    <https://x.com/pauline_makes/status/2086855015243600090> ([I]).
45. MDN browser-compat-data 8.1.6 (2026-10-15): `css.at-rules.media.prefers-reduced-transparency`,
    `prefers-contrast`, `forced-colors`, `css.properties.backdrop-filter` —
    <https://unpkg.com/@mdn/browser-compat-data/data.json> ; MDN page —
    <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency>
46. Electron PR #42862 "feat: add transparency checking to `nativeTheme`" and v31.4.0 / v33.0.0
    release notes — <https://github.com/electron/electron/pull/42862> ;
    <https://www.electronjs.org/docs/latest/api/system-preferences>
47. Lucide icon design guide — <https://lucide.dev/contribute/icon-design-guide>
