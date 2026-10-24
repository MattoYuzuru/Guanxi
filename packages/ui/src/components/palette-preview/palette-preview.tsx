/*
 * Guanxi pattern: side-by-side preview of one palette candidate (D-201) in light and dark.
 * The candidate values come from the generated tokens/palettes/candidates.{css,json}; this
 * component only reads semantic variables, so every real primitive inside it shows the
 * candidate exactly as the product would. Owner-review aid, not a product surface.
 */
import type { ComponentProps } from 'react'
import { paletteCandidateCss, paletteCandidates } from './candidates.ts'
import { useUiText } from '../../i18n/context.tsx'
import type { UiMessageKey } from '../../i18n/messages.ts'
import { cx } from '../../lib/cx.ts'
import { Badge } from '../badge/badge.tsx'
import { Button } from '../button/button.tsx'
import { Switch } from '../switch/switch.tsx'
import './palette-preview.css'

export type PaletteCandidateId = 'porcelain-cobalt' | 'mist-indigo' | 'linen-azure'

export interface PalettePreviewProps extends Omit<ComponentProps<'div'>, 'className'> {
  /** Which generated candidate to show; defaults to the working default. */
  palette?: PaletteCandidateId
  className?: string
}

interface ThemeValues {
  ramp: Record<string, string>
  status: Record<string, string>
  contrast: Record<string, number>
}
interface Candidate { id: string; light: ThemeValues; dark: ThemeValues }
const candidates = paletteCandidates as unknown as Candidate[]

const swatches: { key: UiMessageKey; pick: (theme: ThemeValues) => string }[] = [
  { key: 'ui.palette.surface', pick: (theme) => theme.ramp['1'] ?? '' },
  { key: 'ui.palette.chrome', pick: (theme) => theme.ramp['2'] ?? '' },
  { key: 'ui.palette.accent', pick: (theme) => theme.status.accent ?? '' },
  { key: 'ui.palette.text', pick: (theme) => theme.ramp['12'] ?? '' },
]

function ThemeColumn({ id, theme, values }: { id: string; theme: 'light' | 'dark'; values: ThemeValues }) {
  const t = useUiText()
  return (
    <div className="gx-palette-preview-theme" data-gx-palette={id} data-theme={theme}>
      <div className="gx-palette-preview-chrome">
        <ul className="gx-palette-preview-nav" aria-hidden="true">
          <li data-current="true">{t('ui.palette.navNew')}</li>
          <li>{t('ui.palette.navProjects')}</li>
          <li>{t('ui.palette.navModels')}</li>
        </ul>
        <div className="gx-palette-preview-pane">
          <p className="gx-palette-preview-heading">{t(theme === 'light' ? 'ui.palette.light' : 'ui.palette.dark')}</p>
          <p className="gx-palette-preview-body">{t('ui.palette.sample')}</p>
          <p className="gx-palette-preview-secondary">{t('ui.palette.secondary')}</p>
          <div className="gx-palette-preview-row">
            <Button variant="primary" size="sm">{t('ui.palette.primaryAction')}</Button>
            <Button size="sm">{t('ui.palette.secondaryAction')}</Button>
            <Switch defaultChecked aria-label={t('ui.palette.toggle')} />
          </div>
          <div className="gx-palette-preview-row">
            <Badge tone="success">{t('ui.palette.success')}</Badge>
            <Badge tone="warning">{t('ui.palette.warning')}</Badge>
            <Badge tone="danger">{t('ui.palette.danger')}</Badge>
            <Badge tone="info">{t('ui.palette.info')}</Badge>
          </div>
          <dl className="gx-palette-preview-swatches">
            {swatches.map((swatch) => (
              <div key={swatch.key} className="gx-palette-preview-swatch">
                <dt>{t(swatch.key)}</dt>
                <dd>{swatch.pick(values)}</dd>
              </div>
            ))}
          </dl>
          <p className="gx-palette-preview-secondary">
            {t('ui.palette.contrast', {
              text: String(values.contrast.textOnSurface ?? ''),
              muted: String(values.contrast.muted ?? ''),
              accent: String(values.contrast.accentOnCanvas ?? ''),
            })}
          </p>
        </div>
      </div>
    </div>
  )
}

export function PalettePreview({ palette = 'porcelain-cobalt', className, ...props }: PalettePreviewProps) {
  const candidate = candidates.find((item) => item.id === palette)
  if (!candidate) return null
  return (
    <div data-slot="palette-preview" className={cx('gx-palette-preview', className)} {...props}>
      <style>{paletteCandidateCss}</style>
      <div className="gx-palette-preview-columns">
        <ThemeColumn id={candidate.id} theme="light" values={candidate.light} />
        <ThemeColumn id={candidate.id} theme="dark" values={candidate.dark} />
      </div>
    </div>
  )
}
