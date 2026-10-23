/*
 * Guanxi primitive: a segmented control — one choice out of two to five, shown as a track with
 * the selected segment raised. Built on Base UI RadioGroup and Radio, so it is a radio group to
 * assistive technology with arrow-key navigation. Icon-only segments carry their label as the
 * accessible name and a tooltip.
 */
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'
import { Icon, type IconName } from '../icon/icon.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip/tooltip.tsx'
import './segmented-control.css'

export interface SegmentedOption<Value extends string> {
  value: Value
  /** Visible text, or the accessible name and tooltip when `iconOnly`. */
  label: string
  icon?: IconName
  disabled?: boolean
}

export interface SegmentedControlProps<Value extends string>
  extends Omit<ComponentProps<'div'>, 'className' | 'onChange' | 'defaultValue'> {
  /** Accessible name of the group. */
  label: string
  options: readonly SegmentedOption<Value>[]
  value: Value
  onValueChange: (value: Value) => void
  /** Shows icons only; each label becomes the segment's name and tooltip. */
  iconOnly?: boolean
  disabled?: boolean
  className?: string
}

export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onValueChange,
  iconOnly = false,
  disabled,
  className,
  ...props
}: SegmentedControlProps<Value>) {
  return (
    <RadioGroup
      data-slot="segmented-control"
      aria-label={label}
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      disabled={disabled}
      className={cx('gx-segmented', className)}
      data-icon-only={iconOnly || undefined}
      {...props}
    >
      {options.map((option) => {
        const segment = (
          <Radio.Root
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            aria-label={iconOnly ? option.label : undefined}
            className="gx-segmented-item gx-focusable"
          >
            {option.icon ? <Icon name={option.icon} size={16} /> : null}
            {iconOnly ? null : <span>{option.label}</span>}
          </Radio.Root>
        )
        if (!iconOnly) return segment
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={segment} />
            <TooltipContent side="bottom">{option.label}</TooltipContent>
          </Tooltip>
        )
      })}
    </RadioGroup>
  )
}
