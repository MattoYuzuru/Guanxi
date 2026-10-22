/**
 * The app-shell-chrome loading and offline stories are synthetic host fixtures, not runtime
 * observations. Loading must show localized loading content and a busy main area without a run
 * status or transcript; offline must name connection unavailability without plugin-enable or
 * retry advice. The generic unknown story stays distinct. Component behavior remains covered by
 * app-shell-chrome.test.tsx; this file only binds the catalog state copy to its meaning.
 */
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { StoryView } from '../catalog/StoryView.tsx'
import type { AppShellChromeProps } from '../src/components/app-shell-chrome/app-shell-chrome.tsx'
import * as stories from '../src/components/app-shell-chrome/app-shell-chrome.stories.tsx'
import { translateUi, UiLocaleProvider, type UiLocale } from '../src/i18n/context.tsx'
import type { Story } from '../src/story-kit/index.tsx'

const meta = stories.default

const COPY = {
  en: {
    loading: 'Loading',
    loadingBody: 'Loading content from the node.',
    offline: 'Not connected',
    offlineBody: 'Not connected to the node. No live data is available.',
    transcript: 'The transcript of this session.',
    unknown: 'Context usage is unknown until the session has a model observation.',
    pluginAdvice: 'This block is unavailable. Enable its plugin to restore it.',
    running: 'Running',
  },
  ru: {
    loading: 'Загрузка',
    loadingBody: 'Загружается содержимое узла.',
    offline: 'Нет подключения',
    offlineBody: 'Нет подключения к узлу. Актуальные данные недоступны.',
    transcript: 'Переписка этой сессии.',
    unknown: 'Использование контекста неизвестно до наблюдения модели в сессии.',
    pluginAdvice: 'Блок недоступен. Включите его плагин, чтобы восстановить блок.',
    running: 'Выполняется',
  },
} as const

type LocaleCopy = (typeof COPY)[keyof typeof COPY]

function renderStory(locale: UiLocale, story: Story<AppShellChromeProps>) {
  return render(
    <UiLocaleProvider locale={locale}>
      <StoryView meta={meta} story={story} />
    </UiLocaleProvider>,
  )
}

/** No run status, transcript or status pill may be inferred from a loading story. */
function expectNoRunOrTranscript(copy: LocaleCopy) {
  expect(
    document.querySelector('[data-slot="status-pill"]'),
    'loading does not reuse a run status pill',
  ).toBeNull()
  expect(document.querySelector('[data-status="running"]')).toBeNull()
  expect(screen.queryByText(copy.running)).toBeNull()
  expect(screen.queryByText(copy.transcript)).toBeNull()
}

for (const locale of ['en', 'ru'] as const) {
  it(`renders localized loading without a run or transcript claim in ${locale}`, () => {
    const copy = COPY[locale]
    const view = renderStory(locale, stories.Loading)

    // The status region itself announces the loading state.
    expect(screen.getByRole('status').textContent).toBe(copy.loading)
    expect(screen.getByText(copy.loadingBody).closest('[aria-busy="true"]')).not.toBeNull()
    expectNoRunOrTranscript(copy)

    view.unmount()
  })

  it(`renders localized not-connected offline copy without repair advice in ${locale}`, () => {
    const copy = COPY[locale]
    const repairAdvice = locale === 'en' ? /enable.*plugin/i : /включите.*плагин/i
    const retry = locale === 'en' ? /retry/i : /повтор/i
    const view = renderStory(locale, stories.Offline)

    expect(screen.getByText(copy.offline)).toBeTruthy()
    expect(screen.getByText(copy.offlineBody)).toBeTruthy()
    expect(screen.queryByText(copy.pluginAdvice)).toBeNull()
    expect(screen.queryByText(repairAdvice)).toBeNull()
    expect(screen.queryByRole('button', { name: retry })).toBeNull()
    expect(
      document.querySelector('[data-slot="status-pill"]'),
      'offline is a connection state, not a run status',
    ).toBeNull()
    expect(document.querySelector('[data-status="unknown"]')).toBeNull()
    expect(screen.queryByText(copy.unknown)).toBeNull()

    view.unmount()
  })
}

it('renders the loading state in the pseudo-locale without raw English', () => {
  const statusText = translateUi('pseudo', 'story.appShell.hostLoading')
  const bodyText = translateUi('pseudo', 'story.appShell.hostLoadingBody')
  expect(statusText.length).toBeGreaterThanOrEqual(Math.ceil('Loading'.length * 1.4))
  expect(bodyText.length).toBeGreaterThanOrEqual(Math.ceil('Loading content from the node.'.length * 1.4))

  const view = renderStory('pseudo', stories.Loading)
  expect(screen.getByRole('status').textContent).toBe(statusText)
  expect(screen.getByText(bodyText).closest('[aria-busy="true"]')).not.toBeNull()
  expect(screen.queryByText('Loading')).toBeNull()
  expect(screen.queryByText('Running')).toBeNull()
  expect(document.querySelector('[data-slot="status-pill"]')).toBeNull()

  view.unmount()
})

it('renders the not-connected state in the pseudo-locale without repair advice', () => {
  const statusText = translateUi('pseudo', 'story.appShell.hostOffline')
  const bodyText = translateUi('pseudo', 'story.appShell.hostOfflineBody')
  expect(statusText.length).toBeGreaterThanOrEqual(Math.ceil('Not connected'.length * 1.4))
  expect(
    bodyText.length,
  ).toBeGreaterThanOrEqual(Math.ceil('Not connected to the node. No live data is available.'.length * 1.4))

  const view = renderStory('pseudo', stories.Offline)
  expect(screen.getByText(statusText)).toBeTruthy()
  expect(screen.getByText(bodyText)).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  expect(screen.queryByText(/enable.*plugin/i)).toBeNull()
  expect(document.querySelector('[data-slot="status-pill"]')).toBeNull()

  view.unmount()
})

for (const locale of ['en', 'ru'] as const) {
  it(`keeps offline distinct from the generic unknown state in ${locale}`, () => {
    const copy = COPY[locale]
    const offline = renderStory(locale, stories.Offline)
    const offlineMain = document.querySelector('[data-slot="app-shell-main"]')?.textContent ?? ''
    offline.unmount()

    renderStory(locale, stories.Unknown)
    const unknownMain = document.querySelector('[data-slot="app-shell-main"]')?.textContent ?? ''

    expect(screen.getByText(copy.unknown)).toBeTruthy()
    expect(screen.getByText(locale === 'en' ? 'Unknown' : 'Неизвестно')).toBeTruthy()
    expect(document.querySelector('[data-slot="status-pill"]')?.getAttribute('data-status')).toBe(
      'unknown',
    )
    expect(unknownMain).not.toBe(offlineMain)
    expect(unknownMain).not.toContain(copy.offline)
    expect(unknownMain).not.toContain(copy.offlineBody)
  })
}
