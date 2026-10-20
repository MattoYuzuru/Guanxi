// G15 seed: hard-coded copy that reaches JSX through a constant and a conditional.
const label = 'Untranslated save'

export function SeededIndirect({ busy }: { busy: boolean }) {
  return (
    <button type="button" aria-label={label}>
      {busy ? 'Saving now' : label}
    </button>
  )
}
