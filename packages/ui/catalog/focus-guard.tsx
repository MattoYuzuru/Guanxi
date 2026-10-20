import { useLayoutEffect } from 'react'

/**
 * Open-state stories (select, menu, popover) move focus into their popup and scroll the
 * selected option into view when they mount, which can happen late (a hidden tab runs its
 * animation frames only when shown). In a grid of states that would yank the page. Until the
 * user acts, focus that lands inside the catalog stage goes back to where it was and the page
 * keeps its scroll position; there is no timeout, so late focus steals are blocked too.
 *
 * Render it as the first child of the stage: React runs layout effects in tree order, so the
 * listeners are in place before any story's own effects run.
 */
export function FocusGuard({ stage, watch }: { stage: string; watch: unknown }) {
  useLayoutEffect(() => {
    const root = () => document.querySelector(`[data-focus-stage="${stage}"]`)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const scroll = { x: window.scrollX, y: window.scrollY }
    let acted = false
    const onUser = () => {
      acted = true
    }
    const onFocusIn = (event: FocusEvent) => {
      const container = root()
      if (acted || !container || !(event.target instanceof HTMLElement) || !container.contains(event.target)) return
      const stolen = event.target
      // After the popup's own focus handling settles, hand focus back without scrolling.
      window.setTimeout(() => {
        if (acted || document.activeElement !== stolen) return
        if (previous && previous !== document.body && !container.contains(previous)) previous.focus({ preventScroll: true })
        else stolen.blur()
        window.scrollTo(scroll.x, scroll.y)
      }, 0)
      window.scrollTo(scroll.x, scroll.y)
    }
    const onScroll = () => {
      if (!acted && (window.scrollX !== scroll.x || window.scrollY !== scroll.y)) window.scrollTo(scroll.x, scroll.y)
    }
    const userEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    document.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('scroll', onScroll, true)
    for (const name of userEvents) window.addEventListener(name, onUser, { capture: true, passive: true })
    function cleanup() {
      document.removeEventListener('focusin', onFocusIn, true)
      window.removeEventListener('scroll', onScroll, true)
      for (const name of userEvents) window.removeEventListener(name, onUser, { capture: true })
    }
    return cleanup
  }, [stage, watch])
  return null
}
