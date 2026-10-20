import { useLayoutEffect } from 'react'

/**
 * Open-state stories (select, menu, popover) move focus into their popup and scroll the
 * selected option into view when they mount, which can happen late (a hidden tab runs its
 * animation frames only when shown). In a grid of states that would yank the page. Until the
 * user acts, focus that lands inside the catalog stage goes back to where it was, and the
 * window and every scrolling ancestor of the stage keep their positions; there is no timeout,
 * so late focus steals are blocked too.
 *
 * Render it as the first child of the stage: React runs layout effects in tree order, so the
 * listeners are in place before any story's own effects run.
 */
export function FocusGuard({ stage, watch }: { stage: string; watch: unknown }) {
  useLayoutEffect(() => {
    const root = () => document.querySelector(`[data-focus-stage="${stage}"]`)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const positions = new Map<Element | Document, { top: number; left: number }>()
    positions.set(document, { top: window.scrollY, left: window.scrollX })
    for (let node = root()?.parentElement ?? null; node; node = node.parentElement) {
      positions.set(node, { top: node.scrollTop, left: node.scrollLeft })
    }
    const restore = (target: Element | Document) => {
      const position = positions.get(target)
      if (!position) return
      if (target === document) {
        if (window.scrollY !== position.top || window.scrollX !== position.left) window.scrollTo(position.left, position.top)
      } else {
        const element = target as Element
        if (element.scrollTop !== position.top) element.scrollTop = position.top
        if (element.scrollLeft !== position.left) element.scrollLeft = position.left
      }
    }
    let acted = false
    const onUser = () => {
      acted = true
    }
    const onFocusIn = (event: FocusEvent) => {
      const container = root()
      if (acted || !container || !(event.target instanceof HTMLElement) || !container.contains(event.target)) return
      // After the popup's own focus handling settles, hand focus back without scrolling.
      window.setTimeout(() => {
        const current = document.activeElement
        if (acted || !(current instanceof HTMLElement) || !container.contains(current)) return
        if (previous && previous !== document.body && !container.contains(previous)) previous.focus({ preventScroll: true })
        else current.blur()
        for (const target of positions.keys()) restore(target)
      }, 0)
    }
    const onScroll = (event: Event) => {
      if (acted) return
      restore(event.target === document || event.target === window ? document : (event.target as Element))
    }
    const userEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('scroll', onScroll, true)
    for (const name of userEvents) window.addEventListener(name, onUser, { capture: true, passive: true })
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('scroll', onScroll, true)
      for (const name of userEvents) window.removeEventListener(name, onUser, { capture: true })
    }
  }, [stage, watch])
  return null
}
