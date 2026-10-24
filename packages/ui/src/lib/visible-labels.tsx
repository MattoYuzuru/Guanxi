import { createContext, useContext, type ReactNode } from 'react'

/**
 * Where controls show their labels as text instead of hover tooltips: a phone overflow sheet, where
 * there is no hover and room for a label beside each icon (P3). Icon controls read it; the accessible
 * name is the same either way.
 */
const VisibleLabelsContext = createContext(false)

export function VisibleLabels({ children }: { children: ReactNode }) {
  return <VisibleLabelsContext.Provider value={true}>{children}</VisibleLabelsContext.Provider>
}

export function useVisibleLabels(): boolean {
  return useContext(VisibleLabelsContext)
}
