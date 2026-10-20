/**
 * Storybook 10: the developer, test and agent harness for @guanxi/ui (D-137). It reads the
 * same portable CSF 3 files as the in-app catalog; nothing here is shipped.
 */
import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/components/*/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
}

export default config
