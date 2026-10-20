/**
 * Storybook preview: the catalog's regime frame (theme, density, glass, motion, transparency,
 * locale) as toolbar globals, the forced-state hook and message-marker resolution, so a story
 * looks the same here as in Settings → Developer → Components.
 */
import type { Decorator, Preview } from '@storybook/react-vite'
import { createElement, type ComponentType } from 'react'
import '../src/styles/token-stub.css'
import '../src/styles/base.css'
import { RegimeFrame } from '../catalog/RegimeFrame.tsx'
import {
  DEFAULT_REGIME,
  DENSITIES,
  GLASS_LEVELS,
  LOCALES,
  MOTIONS,
  THEMES,
  TRANSPARENCIES,
  type Regime,
} from '../catalog/regimes.ts'
import { useUiText } from '../src/i18n/context.tsx'
import { resolveMessages, type GuanxiStoryParameters } from '../src/story-kit/index.tsx'

function toolbar(title: string, values: readonly string[], fallback: string) {
  return {
    description: title,
    toolbar: { title, items: values.map((value) => ({ value, title: value })), dynamicTitle: true },
    defaultValue: fallback,
  }
}

const withRegime: Decorator = (Story, context) => {
  const regime: Regime = {
    theme: context.globals['theme'] ?? DEFAULT_REGIME.theme,
    density: context.globals['density'] ?? DEFAULT_REGIME.density,
    glass: context.globals['glass'] ?? DEFAULT_REGIME.glass,
    motion: context.globals['motion'] ?? DEFAULT_REGIME.motion,
    transparency: context.globals['transparency'] ?? DEFAULT_REGIME.transparency,
    locale: context.globals['locale'] ?? DEFAULT_REGIME.locale,
  }
  const force = (context.parameters['guanxi'] as GuanxiStoryParameters | undefined)?.force
  return createElement(
    RegimeFrame,
    { regime },
    createElement('div', { className: 'gx-story-root', 'data-gx-force': force }, createElement(Story)),
  )
}

/** Default render: resolve message markers in args, then render the component. */
function Resolved({ component, args }: { component: ComponentType<Record<string, unknown>>; args: Record<string, unknown> }) {
  const t = useUiText()
  return createElement(component, resolveMessages(args, t))
}

const preview: Preview = {
  globalTypes: {
    theme: toolbar('Theme', THEMES, DEFAULT_REGIME.theme),
    density: toolbar('Density', DENSITIES, DEFAULT_REGIME.density),
    glass: toolbar('Material', GLASS_LEVELS, DEFAULT_REGIME.glass),
    motion: toolbar('Motion', MOTIONS, DEFAULT_REGIME.motion),
    transparency: toolbar('Transparency', TRANSPARENCIES, DEFAULT_REGIME.transparency),
    locale: toolbar('Language', LOCALES, DEFAULT_REGIME.locale),
  },
  decorators: [withRegime],
  render: (args, context) =>
    createElement(Resolved, {
      component: context.component as ComponentType<Record<string, unknown>>,
      args: args as Record<string, unknown>,
    }),
  parameters: {
    // G14's twin inside Storybook: serious axe findings fail the story's test.
    a11y: { test: 'error' },
    layout: 'padded',
  },
}

export default preview
