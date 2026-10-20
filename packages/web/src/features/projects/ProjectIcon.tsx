import type { CSSProperties } from 'react'
import {
  Binary,
  BookOpen,
  Bookmark,
  Box,
  Braces,
  Briefcase,
  CalendarDays,
  Camera,
  Cloud,
  Code2,
  Coffee,
  Database,
  Dumbbell,
  Film,
  Flag,
  FlaskConical,
  Folder,
  Gauge,
  GitBranch,
  GraduationCap,
  HardDrive,
  Heart,
  Home,
  Layers,
  Library,
  Microscope,
  Mountain,
  Music,
  Network,
  NotebookTabs,
  Palette,
  PenTool,
  Plane,
  Rocket,
  Search,
  Server,
  Settings,
  Shapes,
  Sparkles,
  SquareTerminal,
  Star,
  Target,
  Telescope,
  UserRound,
  Users,
  WandSparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import {
  PROJECT_COLOR_PALETTE,
  type ProjectColorToken,
  type ProjectIconKey,
} from '@guanxi/contract'

const projectIcons: Record<ProjectIconKey, LucideIcon> = {
  folder: Folder,
  briefcase: Briefcase,
  star: Star,
  home: Home,
  bookmark: Bookmark,
  flag: Flag,
  target: Target,
  rocket: Rocket,
  code: Code2,
  terminal: SquareTerminal,
  braces: Braces,
  'git-branch': GitBranch,
  database: Database,
  server: Server,
  binary: Binary,
  wrench: Wrench,
  'book-open': BookOpen,
  search: Search,
  microscope: Microscope,
  flask: FlaskConical,
  'graduation-cap': GraduationCap,
  library: Library,
  telescope: Telescope,
  notebook: NotebookTabs,
  palette: Palette,
  'pen-tool': PenTool,
  music: Music,
  camera: Camera,
  film: Film,
  shapes: Shapes,
  sparkles: Sparkles,
  wand: WandSparkles,
  settings: Settings,
  gauge: Gauge,
  network: Network,
  cloud: Cloud,
  'hard-drive': HardDrive,
  box: Box,
  layers: Layers,
  workflow: Workflow,
  heart: Heart,
  users: Users,
  user: UserRound,
  calendar: CalendarDays,
  coffee: Coffee,
  plane: Plane,
  mountain: Mountain,
  dumbbell: Dumbbell,
}

export function ProjectIcon({ iconKey, size = 20 }: { iconKey: ProjectIconKey; size?: number }) {
  const Icon = projectIcons[iconKey]
  return <Icon aria-hidden="true" focusable="false" size={size} strokeWidth={1.8} />
}

type ProjectColorStyle = CSSProperties & {
  '--project-color-light-bg': string
  '--project-color-light-fg': string
  '--project-color-dark-bg': string
  '--project-color-dark-fg': string
}

export function projectColorStyle(token: ProjectColorToken): ProjectColorStyle {
  const color = PROJECT_COLOR_PALETTE.find((candidate) => candidate.token === token)!
  return {
    '--project-color-light-bg': color.light.background,
    '--project-color-light-fg': color.light.foreground,
    '--project-color-dark-bg': color.dark.background,
    '--project-color-dark-fg': color.dark.foreground,
  }
}
