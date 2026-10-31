import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PRODUCT_NAME } from '@guanxi/contract/brand'
import { catalogues, pickLocale, translate } from '../../src/messages.ts'
import type { MessageKey } from '../../src/messages.ts'
import { describeState, escapeHtml, renderStatusPage, statusPageUrl } from '../../src/status-page.ts'
import type { ShellState } from '../../src/status-page.ts'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
const keys = Object.keys(catalogues.en) as MessageKey[]

describe('message catalogues', () => {
  it('Russian has exactly the English keys', () => {
    assert.deepEqual(Object.keys(catalogues.ru).sort(), [...keys].sort())
  })

  it('every key uses the same placeholders in both languages', () => {
    for (const key of keys) assert.deepEqual(placeholders(catalogues.ru[key]), placeholders(catalogues.en[key]), key)
  })

  it('every Russian string is actually Russian, and none is a copy of the English', () => {
    for (const key of keys) {
      assert.match(catalogues.ru[key], /[А-Яа-яЁё]/, key)
      assert.notEqual(catalogues.ru[key], catalogues.en[key], key)
    }
  })

  it('the product name is never a literal: it arrives through {product}', () => {
    for (const locale of ['en', 'ru'] as const) {
      for (const key of keys) assert.ok(!catalogues[locale][key].includes(PRODUCT_NAME), `${locale} ${key} hardcodes the product name`)
    }
  })

  it('picks Russian only for Russian locales', () => {
    for (const ru of ['ru', 'ru-RU', 'ru_RU', 'RU']) assert.equal(pickLocale(ru), 'ru')
    for (const other of ['en-US', 'de', 'ruby', 'uk-UA', '']) assert.equal(pickLocale(other), 'en')
  })

  it('translate fills placeholders and leaves unknown ones visible', () => {
    assert.equal(translate('en', 'status.port_busy.title', { port: 4441 }), 'Port 4441 is in use')
    assert.equal(translate('en', 'status.port_busy.title'), 'Port {port} is in use')
  })
})

const context = (locale: 'en' | 'ru') => ({ locale, product: PRODUCT_NAME, port: 4441 })
const states: ShellState[] = [
  { kind: 'checking' },
  { kind: 'starting' },
  { kind: 'stopped' },
  { kind: 'config_invalid', variable: 'GUANXI_API_PORT', value: 'abc' },
  { kind: 'failure', failure: { code: 'service_missing', entry: '/x/bin.js' } },
  { kind: 'failure', failure: { code: 'service_missing', entry: '/x/bin.js', detail: 'spawn ENOENT' } },
  { kind: 'failure', failure: { code: 'port_busy', port: 4441 } },
  { kind: 'failure', failure: { code: 'health_timeout', port: 4441, timeoutMs: 30_000, startedByShell: true, stopped: true } },
  { kind: 'failure', failure: { code: 'health_timeout', port: 4441, timeoutMs: 5_000, startedByShell: false, stopped: true } },
  { kind: 'failure', failure: { code: 'service_exited', exitCode: 3, signal: null, logPath: '/d/service.log' } },
  { kind: 'failure', failure: { code: 'service_exited', exitCode: null, signal: 'SIGKILL', logPath: '/d/service.log' } },
  { kind: 'failure', failure: { code: 'ui_missing', port: 4441 } },
  { kind: 'load_failed' },
  { kind: 'failure', failure: { code: 'port_owned_by_other_user', port: 4441 } },
  { kind: 'failure', failure: { code: 'port_unverified', port: 4441 } },
  { kind: 'failure', failure: { code: 'health_timeout', port: 4441, timeoutMs: 30_000, startedByShell: true, stopped: false, pid: 4242 } },
]

describe('status screens', () => {
  for (const locale of ['en', 'ru'] as const) {
    it(`every state renders a complete ${locale} screen with no unfilled placeholder`, () => {
      for (const state of states) {
        const description = describeState(state, context(locale))
        for (const text of [description.title, description.body, description.detail ?? '', description.footer ?? '']) {
          assert.doesNotMatch(text, /\{\w+\}/, `${description.id}: ${text}`)
        }
        assert.ok(description.title.length > 0 && description.body.length > 0)
        const html = renderStatusPage(description, locale)
        assert.match(html, new RegExp(`<html lang="${locale}">`))
        assert.match(html, new RegExp(`data-state="${description.id}"`))
      }
    })
  }

  it('failures say what to do and include the facts: port, entry, exit code, log path', () => {
    const text = (state: ShellState) => { const d = describeState(state, context('en')); return `${d.title} ${d.body} ${d.detail ?? ''}` }
    assert.match(text(states[4]!), /\/x\/bin\.js/)
    assert.match(text(states[5]!), /spawn ENOENT/)
    assert.match(text(states[6]!), /4441.*GUANXI_API_PORT/s)
    assert.match(text(states[7]!), /30 seconds/)
    assert.match(text(states[9]!), /exit code 3.*\/d\/service\.log/s)
    assert.match(text(states[10]!), /SIGKILL/)
    assert.match(text(states[13]!), /another user/)
    assert.match(text(states[14]!), /lsof/)
    assert.match(text(states[15]!), /could not be stopped \(process 4242\)/)
    // The advice for a Dock-launched app: close the other program, reopen; the variable is for a terminal start.
    assert.match(text(states[6]!), /Close that program and open Guanxi again.*from a terminal with GUANXI_API_PORT/s)
  })

  it('errors are announced (role=alert); progress is polite status', () => {
    const error = renderStatusPage(describeState(states[6]!, context('en')), 'en')
    const progress = renderStatusPage(describeState(states[0]!, context('en')), 'en')
    assert.match(error, /role="alert"/)
    assert.match(progress, /role="status" aria-live="polite"/)
  })

  it('the page is inert: no script, no remote reference, no control, a locked-down CSP', () => {
    for (const state of states) {
      const html = renderStatusPage(describeState(state, context('en')), 'en')
      assert.doesNotMatch(html, /<script|<img|<link|<iframe|<form|<button|<a[\s>]|https?:\/\//i)
      assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/)
    }
  })

  it('escapes anything that comes from the system (paths, messages)', () => {
    const html = renderStatusPage(describeState({ kind: 'failure', failure: { code: 'service_missing', entry: '/x/<img src=x onerror=alert(1)>"&', detail: "'><script>" } }, context('en')), 'en')
    assert.doesNotMatch(html, /<img|<script/i)
    assert.match(html, /&#60;img src=x/)
    assert.equal(escapeHtml(`<>&"'`), '&#60;&#62;&#38;&#34;&#39;')
  })

  it('the data URL round-trips', () => {
    const html = renderStatusPage(describeState(states[0]!, context('ru')), 'ru')
    const url = statusPageUrl(html)
    assert.ok(url.startsWith('data:text/html;charset=utf-8,'))
    assert.equal(decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length)), html)
  })
})
