import type { ReactNode } from 'react'
import { Button } from '@guanxi/ui'

/** A two-state choice built on the reviewed Button: `aria-pressed` carries the state, the check mark repeats it visibly. */
export function ToggleButton({ pressed, onPressedChange, disabled, describedBy, children }: {
  pressed: boolean; onPressedChange: (next: boolean) => void; disabled?: boolean; describedBy?: string | undefined; children: ReactNode
}) {
  return <Button size="sm" variant={pressed ? 'primary' : 'secondary'} aria-pressed={pressed} disabled={disabled} aria-describedby={describedBy}
    className="h-auto! w-fit max-w-full whitespace-normal! break-words py-1 text-left" onClick={() => onPressedChange(!pressed)}>
    <span aria-hidden="true">{pressed ? '✓ ' : ''}</span>{children}
  </Button>
}
