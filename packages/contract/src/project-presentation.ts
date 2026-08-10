/**
 * Canonical Project presentation manifest.
 *
 * Persisted keys are application-owned and remain stable even when the rendering
 * library changes. `sourceIcon` is presentation-only and must never be used as
 * Project identity or a permission input.
 */
export const PROJECT_PRESENTATION_VERSION = 1 as const
export const DEFAULT_PROJECT_ICON_KEY = 'folder' as const
export const DEFAULT_PROJECT_COLOR_TOKEN = 'slate' as const

export const PROJECT_ICON_SOURCE = Object.freeze({
  library: 'Lucide',
  package: 'lucide-react',
  license: 'ISC',
  homepage: 'https://lucide.dev/',
  licenseUrl: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE',
  verifiedAt: '2026-08-10',
})

export const PROJECT_ICON_CATEGORIES = [
  'general',
  'code',
  'research',
  'creative',
  'systems',
  'personal',
] as const
export type ProjectIconCategory = (typeof PROJECT_ICON_CATEGORIES)[number]

export const PROJECT_ICON_MANIFEST = [
  { key: 'folder', sourceIcon: 'Folder', category: 'general', nameKey: 'projects.icon.folder' },
  { key: 'briefcase', sourceIcon: 'Briefcase', category: 'general', nameKey: 'projects.icon.briefcase' },
  { key: 'star', sourceIcon: 'Star', category: 'general', nameKey: 'projects.icon.star' },
  { key: 'home', sourceIcon: 'Home', category: 'general', nameKey: 'projects.icon.home' },
  { key: 'bookmark', sourceIcon: 'Bookmark', category: 'general', nameKey: 'projects.icon.bookmark' },
  { key: 'flag', sourceIcon: 'Flag', category: 'general', nameKey: 'projects.icon.flag' },
  { key: 'target', sourceIcon: 'Target', category: 'general', nameKey: 'projects.icon.target' },
  { key: 'rocket', sourceIcon: 'Rocket', category: 'general', nameKey: 'projects.icon.rocket' },
  { key: 'code', sourceIcon: 'Code2', category: 'code', nameKey: 'projects.icon.code' },
  { key: 'terminal', sourceIcon: 'SquareTerminal', category: 'code', nameKey: 'projects.icon.terminal' },
  { key: 'braces', sourceIcon: 'Braces', category: 'code', nameKey: 'projects.icon.braces' },
  { key: 'git-branch', sourceIcon: 'GitBranch', category: 'code', nameKey: 'projects.icon.gitBranch' },
  { key: 'database', sourceIcon: 'Database', category: 'code', nameKey: 'projects.icon.database' },
  { key: 'server', sourceIcon: 'Server', category: 'code', nameKey: 'projects.icon.server' },
  { key: 'binary', sourceIcon: 'Binary', category: 'code', nameKey: 'projects.icon.binary' },
  { key: 'wrench', sourceIcon: 'Wrench', category: 'code', nameKey: 'projects.icon.wrench' },
  { key: 'book-open', sourceIcon: 'BookOpen', category: 'research', nameKey: 'projects.icon.bookOpen' },
  { key: 'search', sourceIcon: 'Search', category: 'research', nameKey: 'projects.icon.search' },
  { key: 'microscope', sourceIcon: 'Microscope', category: 'research', nameKey: 'projects.icon.microscope' },
  { key: 'flask', sourceIcon: 'FlaskConical', category: 'research', nameKey: 'projects.icon.flask' },
  { key: 'graduation-cap', sourceIcon: 'GraduationCap', category: 'research', nameKey: 'projects.icon.graduationCap' },
  { key: 'library', sourceIcon: 'Library', category: 'research', nameKey: 'projects.icon.library' },
  { key: 'telescope', sourceIcon: 'Telescope', category: 'research', nameKey: 'projects.icon.telescope' },
  { key: 'notebook', sourceIcon: 'NotebookTabs', category: 'research', nameKey: 'projects.icon.notebook' },
  { key: 'palette', sourceIcon: 'Palette', category: 'creative', nameKey: 'projects.icon.palette' },
  { key: 'pen-tool', sourceIcon: 'PenTool', category: 'creative', nameKey: 'projects.icon.penTool' },
  { key: 'music', sourceIcon: 'Music', category: 'creative', nameKey: 'projects.icon.music' },
  { key: 'camera', sourceIcon: 'Camera', category: 'creative', nameKey: 'projects.icon.camera' },
  { key: 'film', sourceIcon: 'Film', category: 'creative', nameKey: 'projects.icon.film' },
  { key: 'shapes', sourceIcon: 'Shapes', category: 'creative', nameKey: 'projects.icon.shapes' },
  { key: 'sparkles', sourceIcon: 'Sparkles', category: 'creative', nameKey: 'projects.icon.sparkles' },
  { key: 'wand', sourceIcon: 'WandSparkles', category: 'creative', nameKey: 'projects.icon.wand' },
  { key: 'settings', sourceIcon: 'Settings', category: 'systems', nameKey: 'projects.icon.settings' },
  { key: 'gauge', sourceIcon: 'Gauge', category: 'systems', nameKey: 'projects.icon.gauge' },
  { key: 'network', sourceIcon: 'Network', category: 'systems', nameKey: 'projects.icon.network' },
  { key: 'cloud', sourceIcon: 'Cloud', category: 'systems', nameKey: 'projects.icon.cloud' },
  { key: 'hard-drive', sourceIcon: 'HardDrive', category: 'systems', nameKey: 'projects.icon.hardDrive' },
  { key: 'box', sourceIcon: 'Box', category: 'systems', nameKey: 'projects.icon.box' },
  { key: 'layers', sourceIcon: 'Layers', category: 'systems', nameKey: 'projects.icon.layers' },
  { key: 'workflow', sourceIcon: 'Workflow', category: 'systems', nameKey: 'projects.icon.workflow' },
  { key: 'heart', sourceIcon: 'Heart', category: 'personal', nameKey: 'projects.icon.heart' },
  { key: 'users', sourceIcon: 'Users', category: 'personal', nameKey: 'projects.icon.users' },
  { key: 'user', sourceIcon: 'UserRound', category: 'personal', nameKey: 'projects.icon.user' },
  { key: 'calendar', sourceIcon: 'CalendarDays', category: 'personal', nameKey: 'projects.icon.calendar' },
  { key: 'coffee', sourceIcon: 'Coffee', category: 'personal', nameKey: 'projects.icon.coffee' },
  { key: 'plane', sourceIcon: 'Plane', category: 'personal', nameKey: 'projects.icon.plane' },
  { key: 'mountain', sourceIcon: 'Mountain', category: 'personal', nameKey: 'projects.icon.mountain' },
  { key: 'dumbbell', sourceIcon: 'Dumbbell', category: 'personal', nameKey: 'projects.icon.dumbbell' },
] as const satisfies ReadonlyArray<{
  key: string
  sourceIcon: string
  category: ProjectIconCategory
  nameKey: string
}>

export const PROJECT_ICON_KEYS = PROJECT_ICON_MANIFEST.map((icon) => icon.key) as [
  (typeof PROJECT_ICON_MANIFEST)[number]['key'],
  ...(typeof PROJECT_ICON_MANIFEST)[number]['key'][],
]
export type ProjectIconKey = (typeof PROJECT_ICON_MANIFEST)[number]['key']

export const PROJECT_COLOR_PALETTE = [
  { token: 'slate', nameKey: 'projects.color.slate', light: { background: '#e2e8f0', foreground: '#1e293b' }, dark: { background: '#334155', foreground: '#f8fafc' } },
  { token: 'blue', nameKey: 'projects.color.blue', light: { background: '#dbeafe', foreground: '#1e3a8a' }, dark: { background: '#1e40af', foreground: '#eff6ff' } },
  { token: 'cyan', nameKey: 'projects.color.cyan', light: { background: '#cffafe', foreground: '#164e63' }, dark: { background: '#155e75', foreground: '#ecfeff' } },
  { token: 'green', nameKey: 'projects.color.green', light: { background: '#dcfce7', foreground: '#14532d' }, dark: { background: '#166534', foreground: '#f0fdf4' } },
  { token: 'amber', nameKey: 'projects.color.amber', light: { background: '#fef3c7', foreground: '#78350f' }, dark: { background: '#92400e', foreground: '#fffbeb' } },
  { token: 'orange', nameKey: 'projects.color.orange', light: { background: '#ffedd5', foreground: '#7c2d12' }, dark: { background: '#9a3412', foreground: '#fff7ed' } },
  { token: 'rose', nameKey: 'projects.color.rose', light: { background: '#ffe4e6', foreground: '#881337' }, dark: { background: '#9f1239', foreground: '#fff1f2' } },
  { token: 'violet', nameKey: 'projects.color.violet', light: { background: '#ede9fe', foreground: '#4c1d95' }, dark: { background: '#5b21b6', foreground: '#f5f3ff' } },
] as const

export const PROJECT_COLOR_TOKENS = PROJECT_COLOR_PALETTE.map((color) => color.token) as [
  (typeof PROJECT_COLOR_PALETTE)[number]['token'],
  ...(typeof PROJECT_COLOR_PALETTE)[number]['token'][],
]
export type ProjectColorToken = (typeof PROJECT_COLOR_PALETTE)[number]['token']
