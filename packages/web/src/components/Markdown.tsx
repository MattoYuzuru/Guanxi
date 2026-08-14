/**
 * Markdown + подсветка кода.
 *
 * marked + DOMPurify вместо react-markdown: unified-стек тянет ~150 КБ и строит
 * дерево React-элементов на каждый апдейт, а во время стрима апдейты идут
 * пачками по 20 в секунду. Здесь же — одна строка HTML, которую React
 * вставляет целиком, и одна санитизация поверх.
 *
 * Вывод модели считается недоверенным: рендерим только через DOMPurify.
 */
import { memo, useCallback, useMemo, type MouseEvent } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import { translate } from '../lib/locale.ts'

/* Языки регистрируем поштучно: полный highlight.js — это ~1 МБ. */
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diffLang from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES: Record<string, unknown> = {
  bash,
  css,
  diff: diffLang,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
}

let registered = false
function ensureLanguages() {
  if (registered) return
  registered = true
  for (const [name, definition] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, definition as never)
  }
  hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
  hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
  hljs.registerAliases(['py'], { languageName: 'python' })
  hljs.registerAliases(['sh', 'zsh', 'console'], { languageName: 'bash' })
  hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
  hljs.registerAliases(['yml'], { languageName: 'yaml' })
  hljs.registerAliases(['kt'], { languageName: 'kotlin' })
  hljs.registerAliases(['rs'], { languageName: 'rust' })
}

/* ───────────────────────────── Настройка marked ────────────────────────── */

const marked = new Marked({
  gfm: true,
  breaks: true,
  // Незакрытый блок кода — норма во время стрима, ошибкой это быть не должно.
  silent: true,
})

marked.use({
  renderer: {
    code({ text, lang }) {
      ensureLanguages()
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? ''
      const known = language && hljs.getLanguage(language)

      let body: string
      if (known) {
        try {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value
        } catch {
          body = escapeHtml(text)
        }
      } else {
        body = escapeHtml(text)
      }

      // data-code держит исходник для кнопки копирования: из подсвеченного
      // HTML его пришлось бы вычищать обратно.
      return (
        `<div class="code-block" data-code="${encodeURIComponent(text)}">` +
        `<div class="code-head"><span class="code-lang">${escapeHtml(language || translate('markdown.plainText'))}</span>` +
        `<button type="button" class="code-copy" aria-label="${escapeHtml(translate('markdown.copyCode'))}">${escapeHtml(translate('markdown.copy'))}</button></div>` +
        `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>` +
        `</div>`
      )
    },

    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const safeHref = sanitizeHref(href)
      if (!safeHref) return text
      // Локальное приложение, но ссылки в ответе модели всё равно внешние.
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer nofollow"${
        title ? ` title="${escapeHtml(title)}"` : ''
      }>${text}</a>`
    },
  },
})

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeHref(href: string): string | null {
  const trimmed = href.trim()
  if (/^(https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed
  return null
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'span', 'div', 'button',
    'a', 'ul', 'ol', 'li', 'blockquote', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'input',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'data-code', 'aria-label', 'type', 'checked', 'disabled', 'align'],
  ALLOW_DATA_ATTR: false,
}

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false })
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/* ─────────────────────────────── Компонент ─────────────────────────────── */

/**
 * memo обязателен: во время стрима перерисовывается только последнее
 * сообщение, остальные остаются нетронутыми.
 */
export const Markdown = memo(function Markdown({
  source,
  className,
}: {
  source: string
  className?: string
}) {
  const html = useMemo(() => renderMarkdown(source), [source])

  // Делегирование вместо кнопки на каждый блок: обработчик один на сообщение.
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const button = target.closest('.code-copy')
    if (!button) return

    const block = button.closest('.code-block')
    const encoded = block?.getAttribute('data-code')
    if (!encoded) return

    navigator.clipboard
      .writeText(decodeURIComponent(encoded))
      .then(() => {
        button.textContent = translate('common.copied')
        setTimeout(() => {
          button.textContent = translate('common.copy')
        }, 1400)
      })
      .catch(() => {
        button.textContent = translate('markdown.copyFailed')
        setTimeout(() => {
          button.textContent = translate('common.copy')
        }, 1400)
      })
  }, [])

  return (
    <div
      className={`md ${className ?? ''}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})
