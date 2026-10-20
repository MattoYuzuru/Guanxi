# Guanxi gx — concept 05, vector edition v1

**Status:** design artifact, not integrated into the application · **Date:** 2026-10-19

The owner selected concept 05 from the first logo exploration. The symbol is a manual
Bezier reconstruction of its open lowercase `g`, shared descending diagonal, and detached
upper `x` arm. It preserves the selected direction rather than claiming pixel-identical
tracing of the generated raster.

## Files

| File | Use |
| --- | --- |
| `logo.svg` | Primary ink symbol, transparent background, 512 × 512 viewBox |
| `logo-inverse.svg` | Ivory symbol, transparent background, for dark surfaces |
| `logo-mono.svg` | `currentColor` symbol for inline SVG; black by default in an image |
| `app-icon.svg` | Ivory symbol on an ink rounded square |
| `favicon.svg` | Small icon with wider separation at the upper arm |
| `png/` | Transparent symbol exports and application icons, including 16/32 px favicons |
| `preview.html`, `preview.png` | Light/dark presentation and actual-size specimens |
| `build.mjs`, `render.mjs` | Reproducible vector generation and Chromium raster exports |

The SVG assets contain filled paths and, for icons, one background rectangle. They contain
no raster images, font references, external resources, scripts, filters, or gradients.
The `Guanxi` wordmark in the presentation is system-font preview typography and is not a
portable outlined wordmark deliverable.

Colors: ink `#182322`; ivory `#F4F2E9`. The primary symbol has a transparent background.

Run from the repository root using the existing Node and Playwright installation:

```bash
node assets/brand/guanxi-gx-v1/build.mjs
node assets/brand/guanxi-gx-v1/render.mjs
```

The generator reads the product name from the existing central brand module. The output
SVG and PNG assets are standalone. The renderer uses headless Chromium, not a live model
or the running Guanxi application. No application code or user data is changed.

## Verification

Independent read-only review found no issues in this artifact set. The reviewer compared
the preview with selected concept 05, inspected all five SVG sources, and independently
checked them and all 13 PNG exports in Chromium. The counter is transparent and connected
to the exterior; the small-icon gap is wider than the primary mark's gap. The 16 px icon's
minimum corner alpha is 1/255 from antialiasing; the other exports reach 0.

This is static-asset verification. No application regression or platform installation gate
is claimed. The downloadable ZIP was checked for archive integrity.
