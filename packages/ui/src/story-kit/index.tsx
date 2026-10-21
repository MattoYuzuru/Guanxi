/**
 * Portable CSF 3 profile shared by Storybook and the in-app catalog (COMPONENTS_AND_CATALOG
 * §2, research 02 §4.3): a default export with title, component, args and parameters, and one
 * named export per declared state with `name` equal to the state. No loaders and no `play` in
 * these files; interaction tests go to `<name>.test.stories.tsx`.
 *
 * User-facing story text is a message key, never a literal (G15): `msg('story.x')` in args,
 * or `useUiText()` inside a custom render. `machine('…')` marks a machine value (a path, a
 * model name, a hash) that is never translated.
 */
import type { ComponentType, ReactNode } from 'react'
import type { UiMessageKey } from '../i18n/messages.ts'
import { useUiText, type UiTranslate } from '../i18n/context.tsx'

/** How much room the catalog gives a story: floating layers need space below the trigger. */
export type StoryFrame = 'inline' | 'floating' | 'overlay'
/** Pointer and focus states rendered statically through the [data-gx-force] hook. */
export type ForcedState = 'hover' | 'focus-visible' | 'active'

export interface GuanxiStoryParameters {
  frame?: StoryFrame
  force?: ForcedState
}

export interface StoryMeta<Props> {
  title: string
  component: ComponentType<Props>
  args?: Partial<Props>
  render?: (args: Props) => ReactNode
  parameters?: { guanxi?: GuanxiStoryParameters }
}

export interface Story<Props> {
  name: string
  args?: Partial<Props>
  render?: (args: Props) => ReactNode
  parameters?: { guanxi?: GuanxiStoryParameters }
}

const MESSAGE_PREFIX = '\u0000msg:'

/** A message key in story args; the renderer resolves it in the active locale. */
export function msg(key: UiMessageKey): string {
  return `${MESSAGE_PREFIX}${key}`
}

/** A machine-produced value that stays as is in every locale (paths, hashes, model names). */
export function machine(value: string): string {
  return value
}

export function isMessageMarker(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(MESSAGE_PREFIX)
}

/** Replaces message markers in args (one level of arrays and plain objects) with text. */
export function resolveMessages<T>(value: T, t: UiTranslate): T {
  if (isMessageMarker(value)) return t(value.slice(MESSAGE_PREFIX.length) as UiMessageKey) as T
  if (Array.isArray(value)) return value.map((item) => resolveMessages(item, t)) as T
  if (
    value &&
    typeof value === 'object' &&
    !('$$typeof' in value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveMessages(item, t)]),
    ) as T
  }
  return value
}

/**
 * Wraps a custom story render so message markers in its args are resolved first. Both
 * Storybook and the catalog call `render` while rendering a React component, so the hook is
 * legal here. Default renders are resolved by the renderers themselves.
 */
export function localizedRender<Props>(
  render: (args: Props) => ReactNode,
): (args: Props) => ReactNode {
  return function LocalizedRender(args: Props) {
    const t = useUiText()
    return render(resolveMessages(args, t))
  }
}
