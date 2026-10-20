# ADR-0026: Clients — Electron desktop shell, web/PWA, then native mobile

**Status:** proposed · **Date:** 2026-10-19
**Carries forward:** legacy ADR-0009 and ADR-0013 (user-level service, clients over an
authenticated API).

## Context

Desktop on macOS first, then Fedora/other Linux and Windows; later iOS and Android (REQ-F4); a
phone must watch and control live sessions, including by voice (REQ-B3, REQ-I3). The runtime must live
in a background service so runs survive closed windows.

Lane 2: OpenCode moved from Tauri to Electron because WebKit was slower and the sidecar was
flaky; DSH, Goose, Cherry Studio and Chatbox also use Electron. iOS allows no persistent
background SSE; only visible push wakes the phone; Web Push works for Home Screen web apps
since iOS 16.4.

## Decision

1. **Desktop**: Electron as a thin shell over the user-level Guanxi service. The shell starts
   or attaches to the service with an authenticated handshake and never owns it. Renderer:
   `sandbox: true`, `contextIsolation: true`, no Node in the renderer. Packaging with
   electron-builder: DMG/zip with notarization; AppImage and rpm (Fedora) with auto-update;
   Flatpak without self-update; NSIS on Windows.
2. **Headless nodes** (VPS, workers) run the same service as a plain Node package.
3. **Web**: the same React SPA is served by every node and used by the desktop shell.
4. **Mobile, step 1 — PWA** served by the user's node, with Web Push (VAPID per installation)
   and voice upload via `getUserMedia`.
5. **Mobile, step 2 — native** after a spike on locked-screen audio capture and streaming:
   Expo, for its background audio (D-168); Capacitor is not planned. Whether to hold an Apple
   Developer account is decided after the PWA (D-156). Native push needs a relay or ntfy because self-hosters cannot hold the
   project's APNs key; payloads stay content-free.
6. **New-session screen** (REQ-D2): logo, project picker, prompt box, access mode, model picker,
   microphone, attachment; sidebar entries New, Projects, Models, Settings (list slot).
7. **Image editing**: Filerobot for crop/filters/annotations, Konva for inpainting masks.

## Consequences

Larger desktop download than Tauri; one rendering engine everywhere; Linux packaging matrix to
maintain. The PWA has no background work on iOS.

## Validation

Closing the desktop window during a run does not stop the run (test); the PWA receives a push
on run completion on iOS and Android test devices; packaging smoke on macOS arm64, Fedora and
Windows 11.

## Evidence

Lane 2 §2 ([research](../research/README.md)).
