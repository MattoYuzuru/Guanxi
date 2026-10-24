/*
 * Guanxi icon system (FOUNDATIONS §6, D-202). One registry of semantic names: Lucide (ISC,
 * installed dependency) for common glyphs, plus Guanxi domain icons drawn on Lucide's 24 px
 * grid with the same 1.75 stroke. Features never import Lucide directly (G8); they name an
 * icon here, so a glyph can change in one place.
 */
import {
  Activity, ArrowDown, ArrowUp, BatteryCharging, BatteryLow, BatteryMedium, Bell, Bot, Boxes, Brain,
  Check, ChevronDown, ChevronRight, CircleAlert, CircleDashed, Clock, Cloud, CloudOff, Code2, Coffee,
  Command, Copy, CornerDownLeft, Cpu, Ellipsis, ExternalLink, Eye, EyeOff, FileText, Folder, FolderKanban,
  Gauge, GitBranch, Globe, HardDrive, History, Inbox, Info, Keyboard, Laptop, Layers, LayoutGrid, Lock,
  Maximize2, MemoryStick, MessageSquareText, Mic, Minimize2, Monitor, Moon, Network, Package, PanelLeft,
  PanelRight, Paperclip, Pause, Pin, PinOff, Play, Plug, Plus, Power, Rows2, Rows3, ScrollText, Search,
  Server, Settings2, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal, Smartphone, Sparkles, Square,
  SquarePen, Sun, Terminal, Thermometer, Timer, Trash2, TriangleAlert, Unlock, User, Wand2, WifiOff,
  Workflow, X, Zap, Shapes, ListTree, ListChecks, Container, FileDiff, PanelRightOpen, Move, Save,
  RotateCcw, ChartPie, CopyPlus, type LucideIcon,
} from 'lucide-react'
import type { ComponentProps, ReactElement, SVGProps } from 'react'
import { cx } from '../../lib/cx.ts'
import './icon.css'

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string; absoluteStrokeWidth?: boolean }

/** A domain glyph on the 24 px grid; strokes follow currentColor like Lucide. */
function domainGlyph(paths: (props: { dashed: string }) => ReactElement, displayName: string) {
  function Glyph({ size = 24, strokeWidth = 1.75, absoluteStrokeWidth, ...props }: GlyphProps) {
    const width = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {paths({ dashed: '2.5 2.25' })}
      </svg>
    )
  }
  Glyph.displayName = displayName
  return Glyph
}

/** Unified memory: one die with CPU and GPU cores above a shared pool, pins on both sides. */
const UnifiedMemory = domainGlyph(() => (
  <>
    <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
    <rect x="7.5" y="7.5" width="3.5" height="3.5" rx="0.75" />
    <rect x="13" y="7.5" width="3.5" height="3.5" rx="0.75" />
    <path d="M7.5 14.25h9M7.5 16.75h9M2 9.5h2.5M2 14.5h2.5M19.5 9.5H22M19.5 14.5H22" />
  </>
), 'UnifiedMemory')

/** Free memory pages: a filled page behind a dashed, empty one. */
const FreePages = domainGlyph(({ dashed }) => (
  <>
    <path d="M9 3.5h8a2 2 0 0 1 2 2v11" />
    <rect x="5" y="7" width="11" height="13.5" rx="2" strokeDasharray={dashed} />
  </>
), 'FreePages')

/** Connection / relay: two nodes joined by a 45° line with a gap (FOUNDATIONS §6). */
const Relay = domainGlyph(() => (
  <>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M7.9 16.1l2.6-2.6M13.5 10.5l2.6-2.6" />
  </>
), 'Relay')

/** Lease: a key-shaped hold on a resource slot. */
const Lease = domainGlyph(() => (
  <>
    <rect x="3.5" y="13" width="17" height="7" rx="2" />
    <circle cx="9" cy="7.5" r="3" />
    <path d="M11.5 9l3.5 4M7.5 16.5h0.01" />
  </>
), 'Lease')

/** Hibernating lead: a moon inside a run ring (wakes on an event). */
const Hibernating = domainGlyph(({ dashed }) => (
  <>
    <circle cx="12" cy="12" r="8.5" strokeDasharray={dashed} />
    <path d="M14.5 9.2a3.6 3.6 0 1 0 0.3 5.6 3 3 0 0 1-0.3-5.6z" />
  </>
), 'Hibernating')

const registry = {
  // Devices (D-202, D-209)
  'device-laptop': Laptop,
  'device-desktop': Monitor,
  'device-server': Server,
  'device-phone': Smartphone,
  // Machine facts
  'memory-unified': UnifiedMemory,
  'memory-ram': MemoryStick,
  'memory-free-pages': FreePages,
  storage: HardDrive,
  cpu: Cpu,
  thermal: Thermometer,
  quota: Gauge,
  'keep-awake': Coffee,
  sleep: Moon,
  power: Plug,
  'power-off': Power,
  'battery-charging': BatteryCharging,
  'battery-medium': BatteryMedium,
  'battery-low': BatteryLow,
  inbox: Inbox,
  bell: Bell,
  runtime: Activity,
  relay: Relay,
  lease: Lease,
  hibernating: Hibernating,
  network: Network,
  offline: WifiOff,
  cloud: Cloud,
  'cloud-off': CloudOff,
  // Chrome
  'theme-light': Sun,
  'theme-dark': Moon,
  customise: SlidersHorizontal,
  search: Search,
  command: Command,
  sidebar: PanelLeft,
  'sidebar-right': PanelRight,
  'density-compact': Rows3,
  'density-comfortable': Rows2,
  layers: Layers,
  sparkles: Sparkles,
  keyboard: Keyboard,
  // Navigation
  new: SquarePen,
  projects: FolderKanban,
  folder: Folder,
  models: Boxes,
  settings: Settings2,
  history: History,
  layout: LayoutGrid,
  // Session side panels and layout actions (round 4)
  panels: PanelRightOpen,
  artifacts: Shapes,
  plan: ListChecks,
  processes: ListTree,
  environment: Container,
  changes: FileDiff,
  context: ChartPie,
  move: Move,
  save: Save,
  'save-as': CopyPlus,
  reset: RotateCcw,
  // Session and composer
  send: ArrowUp,
  stop: Square,
  attach: Paperclip,
  voice: Mic,
  'permission-read': Shield,
  'permission-full': ShieldAlert,
  'permission-ok': ShieldCheck,
  lock: Lock,
  unlock: Unlock,
  effort: Brain,
  speed: Zap,
  trace: ScrollText,
  info: Info,
  chat: MessageSquareText,
  agent: Bot,
  user: User,
  workflow: Workflow,
  branch: GitBranch,
  file: FileText,
  terminal: Terminal,
  code: Code2,
  package: Package,
  globe: Globe,
  wand: Wand2,
  clock: Clock,
  timer: Timer,
  // Actions and states
  check: Check,
  close: X,
  plus: Plus,
  copy: Copy,
  external: ExternalLink,
  more: Ellipsis,
  pin: Pin,
  unpin: PinOff,
  trash: Trash2,
  show: Eye,
  hide: EyeOff,
  pause: Pause,
  play: Play,
  expand: Maximize2,
  collapse: Minimize2,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'arrow-down': ArrowDown,
  enter: CornerDownLeft,
  unknown: CircleDashed,
  error: CircleAlert,
  warning: TriangleAlert,
} satisfies Record<string, LucideIcon | ReturnType<typeof domainGlyph>>

export type IconName = keyof typeof registry
export type IconSize = 12 | 14 | 16 | 18 | 20 | 24

/** Every registered name, for the catalog and for tests. */
export const iconNames = Object.keys(registry) as IconName[]
/** Names drawn by Guanxi rather than taken from Lucide. */
export const domainIconNames: IconName[] = ['memory-unified', 'memory-free-pages', 'relay', 'lease', 'hibernating']

export interface IconProps extends Omit<ComponentProps<'svg'>, 'className' | 'name'> {
  name: IconName
  /** Rendered size in px; the stroke stays 1.75 px at every size. */
  size?: IconSize
  /** An accessible name. Without it the icon is decorative and hidden from assistive technology. */
  label?: string
  className?: string
}

export function Icon({ name, size = 16, label, className, ...props }: IconProps) {
  const Glyph = registry[name]
  return (
    <Glyph
      data-slot="icon"
      data-icon={name}
      className={cx('gx-icon', className)}
      size={size}
      strokeWidth={1.75}
      absoluteStrokeWidth
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...props}
    />
  )
}
