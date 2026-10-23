/*
 * Guanxi primitive: a keyboard key or shortcut ("⌘K"). Keys are machine values: the host passes
 * the platform's glyphs, this component only draws them.
 */
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import './kbd.css'

export interface KbdProps extends Omit<ComponentProps<'kbd'>, 'className' | 'children'> {
  /** One entry per key; a combination renders as adjacent keys. */
  keys: string[]
  className?: string
}

export function Kbd({ keys, className, ...props }: KbdProps) {
  return (
    <kbd data-slot="kbd" className={cx('gx-kbd', className)} {...props}>
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className="gx-kbd-key">{key}</kbd>
      ))}
    </kbd>
  )
}
