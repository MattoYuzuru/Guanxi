import { z } from 'zod'

/** Canonical compatibility-safe Project identity, including legacy Workspace IDs. */
export const projectReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim(), 'Project reference must be normalized')

export type ProjectReference = z.infer<typeof projectReferenceSchema>
