import { PRODUCT_ENV_PREFIX } from '@guanxi/contract/brand'

/** Environment variable names come from the brand module's prefix (AGENTS.md: no hardcoded brand strings). */
export const envName = (suffix: string): string => `${PRODUCT_ENV_PREFIX}_${suffix}`

/** Variables that configure this shell only; they never reach the service. */
export const DESKTOP_ENV_PREFIX = envName('DESKTOP_')
