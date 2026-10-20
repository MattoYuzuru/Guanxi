import { Component, createElement, type ErrorInfo, type ReactNode } from 'react'
import { useUiText } from '../src/i18n/context.tsx'
import { resolveMessages, type Story, type StoryMeta } from '../src/story-kit/index.tsx'

// Stories are typed per component; the interpreter only needs the common shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStoryMeta = StoryMeta<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStory = Story<any>

/**
 * The in-app CSF 3 interpreter: merge args, resolve message markers, call `render` or create
 * the component, and apply the catalog-only forced-state hook.
 */
export function StoryView({ meta, story }: { meta: AnyStoryMeta; story: AnyStory }) {
  const t = useUiText()
  const args = resolveMessages({ ...(meta.args ?? {}), ...(story.args ?? {}) }, t)
  const render = story.render ?? meta.render
  const content: ReactNode = render ? render(args) : createElement(meta.component, args)
  const force = story.parameters?.guanxi?.force ?? meta.parameters?.guanxi?.force
  return (
    <div className="gx-story-root" data-gx-force={force}>
      {content}
    </div>
  )
}

export class StoryBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Catalog story failed', error, info.componentStack)
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
