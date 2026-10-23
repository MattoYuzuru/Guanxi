/**
 * @guanxi/ui public surface. Features and plugins import only from here (G8); every exported
 * component has a folder under components/ with stories, docs and a review record (G10).
 */
import './styles/base.css'

export * from './components/app-shell-chrome/index.ts'
export * from './components/badge/index.ts'
export * from './components/button/index.ts'
export * from './components/checkbox/index.ts'
export * from './components/dialog/index.ts'
export * from './components/empty-state/index.ts'
export * from './components/error-state/index.ts'
export * from './components/icon-button/index.ts'
export * from './components/input/index.ts'
export * from './components/menu/index.ts'
export * from './components/popover/index.ts'
export * from './components/provenance-label/index.ts'
export * from './components/select/index.ts'
export * from './components/status-pill/index.ts'
export * from './components/switch/index.ts'
export * from './components/tabs/index.ts'
export * from './components/textarea/index.ts'
export * from './components/toast/index.ts'
export * from './components/tooltip/index.ts'

export { PortalContainerProvider } from './lib/portal.tsx'
export {
  UiLocaleProvider,
  intlLocale,
  translateUi,
  useUiLocale,
  useUiText,
  type UiLocale,
  type UiTranslate,
} from './i18n/context.tsx'
export type { UiMessageKey } from './i18n/messages.ts'
export * from './components/workspace-chrome/index.ts'
export * from './components/palette-preview/index.ts'
export * from './components/icon/index.ts'
