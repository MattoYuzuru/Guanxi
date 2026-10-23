import type { Story, StoryMeta } from '../../story-kit/index.tsx'
import { PalettePreview, type PalettePreviewProps } from './palette-preview.tsx'

const meta = {
  title: 'Patterns/PalettePreview',
  component: PalettePreview,
  // Full-width cell: the preview shows two themed columns side by side.
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<PalettePreviewProps>

export default meta

export const PorcelainCobaltState: Story<PalettePreviewProps> = { name: 'porcelain-cobalt', args: { palette: 'porcelain-cobalt' } }

export const MistIndigoState: Story<PalettePreviewProps> = { name: 'mist-indigo', args: { palette: 'mist-indigo' } }

export const LinenAzureState: Story<PalettePreviewProps> = { name: 'linen-azure', args: { palette: 'linen-azure' } }
