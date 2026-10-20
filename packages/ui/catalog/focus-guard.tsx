import { useLayoutEffect, type RefObject } from 'react'

/** How long after the page is visible a freshly mounted story may not move focus or scroll. */
const SETTLE_MS = 1500
const USER_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'wheel', 'touchstart', 'click', 'input'] as const

/**
 * Open-state stories (select, menu) move focus into their popup and scroll the selected option
 * into view when they mount; Base UI gives those popups no `initialFocus` switch. In a grid of
 * states that would yank the page. For a short window after the story mounts (counted from
 * when the page is visible, because hidden tabs run animation frames late), focus that lands
 * inside this story goes back where it was and scrolling ancestors keep their positions. Any
 * user input ends the window, and so does the timer: focus moved later by a screen reader or
 * by the user is never touched.
 */
export function useStorySettle(cell: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const root = cell.current
    if (!active || !root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const positions = new Map<Element | Document, { top: number; left: number }>()
    positions.set(document, { top: window.scrollY, left: window.scrollX })
    for (let node = root.parentElement; node; node = node.parentElement) {
      positions.set(node, { top: node.scrollTop, left: node.scrollLeft })
    }
    let done = false
    let timer: number | undefined
    const restore = (target: Element | Document) => {
      const position = positions.get(target)
      if (!position) return
      if (target === document) {
        if (window.scrollY !== position.top || window.scrollX !== position.left) window.scrollTo(position.left, position.top)
        return
      }
      const element = target as Element
      if (element.scrollTop !== position.top) element.scrollTop = position.top
      if (element.scrollLeft !== position.left) element.scrollLeft = position.left
    }
    const onFocusIn = (event: FocusEvent) => {
      if (done || !(event.target instanceof Node) || !root.contains(event.target)) return
      // After the popup's own focus handling settles, hand focus back without scrolling.
      window.setTimeout(() => {
        const current = document.activeElement
        if (done || !(current instanceof HTMLElement) || !root.contains(current)) return
        if (previous?.isConnected && previous !== document.body && !root.contains(previous)) previous.focus({ preventScroll: true })
        else current.blur()
        for (const target of positions.keys()) restore(target)
      }, 0)
    }
    const onScroll = (event: Event) => {
      if (!done) restore(event.target === document ? document : (event.target as Element))
    }
    const finish = () => {
      if (done) return
      done = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('visibilitychange', onVisible)
      for (const name of USER_EVENTS) window.removeEventListener(name, finish, { capture: true })
    }
    function onVisible() {
      if (document.visibilityState === 'visible' && timer === undefined) timer = window.setTimeout(finish, SETTLE_MS)
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('visibilitychange', onVisible)
    for (const name of USER_EVENTS) window.addEventListener(name, finish, { capture: true, passive: true })
    onVisible()
    return finish
  }, [cell, active])
}
