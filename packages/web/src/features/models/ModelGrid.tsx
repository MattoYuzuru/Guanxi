/**
 * Model cards as a responsive grid (round 4, owner feedback 2026-10-23): every card is the same
 * size, fully opaque and unscaled, and the page scrolls vertically. The former drum carousel
 * shrank and faded its neighbours and hid most cards behind arrows; it is gone.
 */
import type { ReactNode } from 'react'
import { cx } from '../../components/ui.tsx'
import './models.css'

export type ModelGridItem = {
  key: string
  render: () => ReactNode
}

export function ModelGrid({ items, ariaLabel, className }: { items: ModelGridItem[]; ariaLabel: string; className?: string }) {
  return (
    <div role="group" aria-label={ariaLabel} className={cx('model-grid', className)} data-testid="model-grid">
      {items.map(item => <div className="model-grid-item" key={item.key}>{item.render()}</div>)}
    </div>
  )
}
