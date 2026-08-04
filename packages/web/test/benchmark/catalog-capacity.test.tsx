import { performance } from 'node:perf_hooks'
import { cleanup, render } from '@testing-library/react'
import { CATALOG_DEFAULT_PAGE_SIZE } from '@alamo/contract'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CatalogPager,
} from '../../src/features/launcher/LauncherPage.tsx'
import { ModelCarousel, type CarouselItem } from '../../src/features/models/ModelCarousel.tsx'

const MODEL_COUNT = 1_000
const VARIANTS_PER_MODEL = 4

function items(count: number): CarouselItem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `synthetic-${String(index).padStart(4, '0')}`,
    render: () => <article>{`Synthetic row ${index} with ${VARIANTS_PER_MODEL} variants`}</article>,
  }))
}

afterEach(cleanup)

describe('catalog DOM capacity diagnostic', () => {
  it('records the 1,000-row carousel baseline and bounded page policy', () => {
    const baselineStartedAt = performance.now()
    const baseline = render(<ModelCarousel items={items(MODEL_COUNT)} ariaLabel="baseline" />)
    const baselineElapsedMs = performance.now() - baselineStartedAt
    const baselineSlides = baseline.container.querySelectorAll('.embla-slide').length
    const baselineDots = baseline.container.querySelectorAll('[role="tab"]').length
    expect(baselineSlides).toBe(MODEL_COUNT)
    expect(baselineDots).toBe(MODEL_COUNT)
    baseline.unmount()

    const boundedStartedAt = performance.now()
    const bounded = render(
      <>
        <ModelCarousel items={items(CATALOG_DEFAULT_PAGE_SIZE)} ariaLabel="bounded" />
        <CatalogPager
          page={1}
          totalPages={Math.ceil(MODEL_COUNT / CATALOG_DEFAULT_PAGE_SIZE)}
          totalItems={MODEL_COUNT}
          pageItems={CATALOG_DEFAULT_PAGE_SIZE}
          previousPage={null}
          nextPage={2}
          loading={false}
          pullActive={false}
          onPage={() => undefined}
        />
      </>,
    )
    const boundedElapsedMs = performance.now() - boundedStartedAt
    const boundedSlides = bounded.container.querySelectorAll('.embla-slide').length
    const boundedDots = bounded.container.querySelectorAll('[role="tab"]').length
    const pagerButtons = bounded.container.querySelectorAll('nav button').length
    expect(boundedSlides).toBe(CATALOG_DEFAULT_PAGE_SIZE)
    expect(boundedDots).toBe(CATALOG_DEFAULT_PAGE_SIZE)
    expect(pagerButtons).toBe(2)

    console.log(JSON.stringify({
      kind: 'local_synthetic_dom_diagnostic',
      fixture: { models: MODEL_COUNT, variants: MODEL_COUNT * VARIANTS_PER_MODEL },
      legacyFullCarousel: {
        renderedSlides: baselineSlides,
        renderedDots: baselineDots,
        elapsedMs: Number(baselineElapsedMs.toFixed(3)),
      },
      explicitPage: {
        pageSize: CATALOG_DEFAULT_PAGE_SIZE,
        renderedSlides: boundedSlides,
        renderedDots: boundedDots,
        pagerButtons,
        elapsedMs: Number(boundedElapsedMs.toFixed(3)),
      },
      timingScope: 'single jsdom run; diagnostic only; not a production SLA',
    }))
  })
})
