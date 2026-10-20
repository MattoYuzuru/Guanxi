/**
 * Просмотр диффа перед записью в файл.
 *
 * Самый ответственный экран: по нему человек решает, пускать ли модель в свои
 * файлы. Поэтому здесь важнее точность, чем краткость:
 *  - два режима, side-by-side и unified;
 *  - подсветка изменений внутри строки, а не только «строка целиком другая»;
 *  - схлопывание неизменённых участков, но с возможностью раскрыть;
 *  - явный счётчик добавленных и удалённых строк.
 */
import { Fragment, useMemo, useState } from 'react'
import { diffLines, diffWordsWithSpace, type Change } from 'diff'
import type { ToolCall } from '@guanxi/contract'
import { Button, CopyButton, cx } from '../../components/ui.tsx'
import { getActiveLocale, translate } from '../../lib/locale.ts'

type DiffKind = 'add' | 'del' | 'ctx'

type Row = {
  kind: DiffKind
  beforeNumber: number | null
  afterNumber: number | null
  text: string
  /** Куски строки: изменённые подсвечиваются. */
  parts: Array<{ text: string; changed: boolean }> | null
}

/** Сколько неизменённых строк оставляем вокруг изменения. */
const CONTEXT_LINES = 3

export function DiffViewer({
  diff,
  defaultMode = 'split',
  maxHeight = 460,
}: {
  diff: NonNullable<ToolCall['diff']>
  defaultMode?: 'split' | 'unified'
  maxHeight?: number
}) {
  const [mode, setMode] = useState<'split' | 'unified'>(defaultMode)
  const [expanded, setExpanded] = useState(false)

  const { rows, added, removed } = useMemo(
    () => buildRows(diff.before, diff.after),
    [diff.before, diff.after],
  )

  const visible = useMemo(
    () => (expanded ? rows.map((row) => ({ row, hidden: 0 })) : collapse(rows)),
    [rows, expanded],
  )

  const unchanged = rows.length - added - removed

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      {/* Шапка */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg-subtle)] px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-2xs font-medium" title={diff.path}>
            {diff.path}
          </span>
          <span className="shrink-0 font-mono text-2xs">
            <span className="text-[var(--color-fit-green)]">+{added}</span>{' '}
            <span className="text-[var(--color-fit-red)]">−{removed}</span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {unchanged > CONTEXT_LINES * 2 && (
            <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
              {expanded ? translate('agent.diff.collapse') : translate('agent.diff.fullFile')}
            </Button>
          )}
          <div className="flex overflow-hidden rounded border border-[var(--border-strong)]">
            <ModeButton active={mode === 'split'} onClick={() => setMode('split')}>
              {translate('agent.diff.split')}
            </ModeButton>
            <ModeButton active={mode === 'unified'} onClick={() => setMode('unified')}>
              {translate('agent.diff.unified')}
            </ModeButton>
          </div>
          <CopyButton text={diff.after} label={translate('agent.diff.copyAfter')} />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-2.5 py-3 text-2xs text-[var(--fg-subtle)]">
          {translate('agent.diff.unchanged')}
        </p>
      ) : (
        <div className="overflow-auto" style={{ maxHeight }}>
          {mode === 'split' ? <SplitView rows={visible} /> : <UnifiedView rows={visible} />}
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'px-1.5 py-0.5 text-2xs font-medium transition-colors',
        active
          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
          : 'bg-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-raised)]',
      )}
    >
      {children}
    </button>
  )
}

type VisibleRow = { row: Row; hidden: number }

/* ────────────────────────────── Режим «подряд» ─────────────────────────── */

function UnifiedView({ rows }: { rows: VisibleRow[] }) {
  return (
    <table className="w-full border-collapse font-mono text-2xs">
      <tbody>
        {rows.map(({ row, hidden }, index) => (
          <Fragment key={index}>
            {hidden > 0 && <SkipRow count={hidden} colSpan={3} />}
            <tr className={rowClass(row.kind)}>
              <LineNumber value={row.beforeNumber} />
              <LineNumber value={row.afterNumber} />
              <td className="w-full py-px pr-2 pl-1.5 whitespace-pre-wrap">
                <Sign kind={row.kind} />
                <LineText row={row} />
              </td>
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

/* ────────────────────────────── Режим «рядом» ──────────────────────────── */

function SplitView({ rows }: { rows: VisibleRow[] }) {
  // Пары «слева удалено / справа добавлено», чтобы правки читались построчно.
  const pairs = useMemo(() => pairRows(rows), [rows])

  return (
    <table className="w-full table-fixed border-collapse font-mono text-2xs">
      <colgroup>
        <col className="w-9" />
        <col className="w-[calc(50%-1.125rem)]" />
        <col className="w-9" />
        <col className="w-[calc(50%-1.125rem)]" />
      </colgroup>
      <tbody>
        {pairs.map((pair, index) => (
          <Fragment key={index}>
            {pair.hidden > 0 && <SkipRow count={pair.hidden} colSpan={4} />}
            <tr>
              <LineNumber value={pair.left?.beforeNumber ?? null} />
              <td
                className={cx(
                  'py-px pr-2 pl-1.5 align-top break-all whitespace-pre-wrap',
                  pair.left ? cellClass(pair.left.kind) : 'bg-[var(--bg-inset)]/40',
                )}
              >
                {pair.left && <LineText row={pair.left} />}
              </td>
              <LineNumber value={pair.right?.afterNumber ?? null} />
              <td
                className={cx(
                  'border-l border-[var(--border)] py-px pr-2 pl-1.5 align-top break-all whitespace-pre-wrap',
                  pair.right ? cellClass(pair.right.kind) : 'bg-[var(--bg-inset)]/40',
                )}
              >
                {pair.right && <LineText row={pair.right} />}
              </td>
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

function pairRows(rows: VisibleRow[]): Array<{ left: Row | null; right: Row | null; hidden: number }> {
  const result: Array<{ left: Row | null; right: Row | null; hidden: number }> = []
  let index = 0

  while (index < rows.length) {
    const entry = rows[index] as VisibleRow
    const hidden = entry.hidden
    const row = entry.row

    if (row.kind === 'ctx') {
      result.push({ left: row, right: row, hidden })
      index += 1
      continue
    }

    // Собираем подряд идущие удаления и добавления и ставим их напротив друг друга.
    const deletions: Row[] = []
    const additions: Row[] = []
    let cursor = index
    let carriedHidden = hidden

    while (cursor < rows.length && (rows[cursor] as VisibleRow).row.kind === 'del') {
      deletions.push((rows[cursor] as VisibleRow).row)
      cursor += 1
    }
    while (cursor < rows.length && (rows[cursor] as VisibleRow).row.kind === 'add') {
      additions.push((rows[cursor] as VisibleRow).row)
      cursor += 1
    }

    const height = Math.max(deletions.length, additions.length)
    for (let offset = 0; offset < height; offset += 1) {
      result.push({
        left: deletions[offset] ?? null,
        right: additions[offset] ?? null,
        hidden: offset === 0 ? carriedHidden : 0,
      })
      carriedHidden = 0
    }

    index = cursor
  }

  return result
}

/* ──────────────────────────────── Ячейки ───────────────────────────────── */

function LineNumber({ value }: { value: number | null }) {
  return (
    <td className="w-9 border-r border-[var(--border)] bg-[var(--bg-subtle)]/60 px-1 py-px text-right align-top text-[var(--fg-subtle)] tabular-nums select-none">
      {value ?? ''}
    </td>
  )
}

function Sign({ kind }: { kind: DiffKind }) {
  const sign = kind === 'add' ? '+' : kind === 'del' ? '−' : ' '
  return (
    <span
      className={cx(
        'mr-1 inline-block w-2 select-none',
        kind === 'add' && 'text-[var(--color-fit-green)]',
        kind === 'del' && 'text-[var(--color-fit-red)]',
      )}
      aria-hidden
    >
      {sign}
    </span>
  )
}

/** Подсветка изменённых кусков внутри строки. */
function LineText({ row }: { row: Row }) {
  if (!row.parts) return <span>{row.text || ' '}</span>

  return (
    <>
      {row.parts.map((part, index) =>
        part.changed ? (
          <mark
            key={index}
            className={cx(
              'rounded-[2px] px-px',
              row.kind === 'add'
                ? 'bg-[var(--color-fit-green)]/30 text-inherit'
                : 'bg-[var(--color-fit-red)]/30 text-inherit',
            )}
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function SkipRow({ count, colSpan }: { count: number; colSpan: number }) {
  const category = new Intl.PluralRules(getActiveLocale()).select(count)
  const key = category === 'one'
    ? 'agent.diff.unchangedLines.one'
    : category === 'few'
      ? 'agent.diff.unchangedLines.few'
      : 'agent.diff.unchangedLines.other'
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="border-y border-[var(--border)] bg-[var(--bg-inset)] px-2 py-0.5 text-center text-[var(--fg-subtle)] select-none"
      >
        · · · {translate(key, { count })} · · ·
      </td>
    </tr>
  )
}

function rowClass(kind: DiffKind): string {
  if (kind === 'add') return 'bg-[var(--color-fit-green)]/10'
  if (kind === 'del') return 'bg-[var(--color-fit-red)]/10'
  return ''
}

function cellClass(kind: DiffKind): string {
  if (kind === 'add') return 'bg-[var(--color-fit-green)]/10'
  if (kind === 'del') return 'bg-[var(--color-fit-red)]/10'
  return ''
}

/* ─────────────────────────────── Построение ────────────────────────────── */

function buildRows(before: string, after: string): { rows: Row[]; added: number; removed: number } {
  const changes: Change[] = diffLines(before, after)

  const rows: Row[] = []
  let beforeNumber = 1
  let afterNumber = 1
  let added = 0
  let removed = 0

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index] as Change
    const lines = splitLines(change.value)

    if (change.added) {
      for (const line of lines) {
        rows.push({ kind: 'add', beforeNumber: null, afterNumber: afterNumber++, text: line, parts: null })
        added += 1
      }
    } else if (change.removed) {
      // Если следом идёт добавление — это правка, а не удаление+вставка.
      const next = changes[index + 1]
      const nextLines = next?.added ? splitLines(next.value) : []

      lines.forEach((line, offset) => {
        const counterpart = nextLines[offset]
        rows.push({
          kind: 'del',
          beforeNumber: beforeNumber++,
          afterNumber: null,
          text: line,
          parts: counterpart === undefined ? null : intraLine(line, counterpart, 'del'),
        })
        removed += 1
      })

      if (next?.added) {
        nextLines.forEach((line, offset) => {
          const counterpart = lines[offset]
          rows.push({
            kind: 'add',
            beforeNumber: null,
            afterNumber: afterNumber++,
            text: line,
            parts: counterpart === undefined ? null : intraLine(counterpart, line, 'add'),
          })
          added += 1
        })
        index += 1
      }
    } else {
      for (const line of lines) {
        rows.push({
          kind: 'ctx',
          beforeNumber: beforeNumber++,
          afterNumber: afterNumber++,
          text: line,
          parts: null,
        })
      }
    }
  }

  return { rows, added, removed }
}

/** Пословный дифф внутри пары строк. */
function intraLine(
  before: string,
  after: string,
  side: 'add' | 'del',
): Array<{ text: string; changed: boolean }> | null {
  // На длинных строках пословный дифф даёт «ёлочку» — там он только мешает.
  if (before.length > 400 || after.length > 400) return null

  const parts = diffWordsWithSpace(before, after)
  const result: Array<{ text: string; changed: boolean }> = []

  for (const part of parts) {
    if (side === 'add') {
      if (part.removed) continue
      result.push({ text: part.value, changed: Boolean(part.added) })
    } else {
      if (part.added) continue
      result.push({ text: part.value, changed: Boolean(part.removed) })
    }
  }

  // Всё изменилось — подсветка каждого куска бессмысленна.
  if (result.every((part) => part.changed)) return null
  return result
}

function splitLines(value: string): string[] {
  const lines = value.split('\n')
  // Хвостовой перевод строки даёт пустой элемент — он не строка файла.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Схлопывание длинных неизменённых участков. */
function collapse(rows: Row[]): VisibleRow[] {
  const keep = new Set<number>()

  rows.forEach((row, index) => {
    if (row.kind === 'ctx') return
    for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES; offset += 1) {
      const target = index + offset
      if (target >= 0 && target < rows.length) keep.add(target)
    }
  })

  const result: VisibleRow[] = []
  let hidden = 0

  rows.forEach((row, index) => {
    if (keep.has(index)) {
      result.push({ row, hidden })
      hidden = 0
    } else {
      hidden += 1
    }
  })

  return result
}
