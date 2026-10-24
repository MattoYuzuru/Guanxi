/**
 * Карусель-барабан.
 *
 * embla даёт перетаскивание с инерцией и подтормаживанием на снапах. Сверху
 * добавлено то, чего в ней нет из коробки:
 *  - горизонтальный скролл трекпадом (deltaX) и shift+колесо для мыши;
 *  - плавный scale/opacity соседних карточек, считается покадрово по
 *    scrollProgress, а не CSS-переходом на активном классе;
 *  - клавиатура: стрелки, Home/End, PageUp/PageDown на самом контейнере;
 *  - Tab: карточка, получившая фокус, доезжает до центра сама.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import type { EmblaCarouselType } from 'embla-carousel'
import { Button, cx } from '../../components/ui.tsx'
import { translate } from '../../lib/locale.ts'

/** Насколько сильно «утапливаются» соседи. 0 — плоский список. */
const TWEEN_SCALE = 0.13
const TWEEN_FADE = 0.55

export type CarouselItem = {
  key: string
  /** `focusIndex` даёт карточке доехать до центра при фокусе с Tab. */
  render: (state: { isSelected: boolean; focusIndex: () => void }) => ReactNode
}

export function ModelCarousel({
  items,
  ariaLabel,
  className,
}: {
  items: CarouselItem[]
  ariaLabel: string
  className?: string
}) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'center',
    containScroll: 'trimSnaps',
    // Барабан: снапы обязательны, но с длинной мягкой доводкой.
    dragFree: false,
    duration: 32,
    skipSnaps: true,
    loop: false,
  })

  const [selected, setSelected] = useState(0)
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(false)
  // Every card fits the row: then this is a plain row, not a carousel (visual pass 3).
  const [fits, setFits] = useState(false)
  const fitsRef = useRef(false)
  const tweenNodesRef = useRef<HTMLElement[]>([])

  /* ── scale/opacity покадрово ── */

  const collectTweenNodes = useCallback((api: EmblaCarouselType) => {
    tweenNodesRef.current = api.slideNodes().map((slide) => {
      // Тюним внутренний узел, а не сам слайд: слайд задаёт геометрию потока,
      // и трансформация на нём ломала бы расчёт снапов.
      return (slide.querySelector('.embla-tween') as HTMLElement | null) ?? slide
    })
  }, [])

  const applyTween = useCallback((api: EmblaCarouselType) => {
    if (fitsRef.current) {
      for (const node of tweenNodesRef.current) { node.style.transform = ''; node.style.opacity = ''; node.style.zIndex = '' }
      return
    }
    const progress = api.scrollProgress()
    const snaps = api.scrollSnapList()
    const nodes = tweenNodesRef.current

    snaps.forEach((snap, index) => {
      const node = nodes[index]
      if (!node) return

      // Расстояние от центра в «снапах»: 0 — по центру, 1 — соседняя.
      const distance = Math.abs(snap - progress) * snaps.length
      const clamped = Math.min(distance, 1.6)

      const scale = 1 - TWEEN_SCALE * clamped
      const opacity = 1 - (1 - TWEEN_FADE) * Math.min(clamped, 1)

      node.style.transform = `scale(${scale.toFixed(4)})`
      node.style.opacity = opacity.toFixed(3)
      // Дальние карточки не должны воровать клики у центральной.
      node.style.zIndex = String(Math.round((2 - clamped) * 10))
    })
  }, [])

  useEffect(() => {
    if (!emblaApi) return

    const sync = () => {
      setSelected(emblaApi.selectedScrollSnap())
      setCanPrev(emblaApi.canScrollPrev())
      setCanNext(emblaApi.canScrollNext())
      const nextFits = emblaApi.scrollSnapList().length <= 1
      fitsRef.current = nextFits
      setFits(nextFits)
    }

    const onReInit = () => {
      collectTweenNodes(emblaApi)
      sync()
      applyTween(emblaApi)
    }
    const onScroll = () => applyTween(emblaApi)
    const onSettle = () => applyTween(emblaApi)

    onReInit()
    emblaApi.on('reInit', onReInit)
    emblaApi.on('select', sync)
    // 'scroll' летит на каждом кадре анимации — здесь это и нужно.
    emblaApi.on('scroll', onScroll)
    emblaApi.on('settle', onSettle)

    return () => {
      emblaApi.off('reInit', onReInit)
      emblaApi.off('select', sync)
      emblaApi.off('scroll', onScroll)
      emblaApi.off('settle', onSettle)
    }
  }, [emblaApi, applyTween, collectTweenNodes])

  /* ── трекпад ── */

  useEffect(() => {
    if (!emblaApi) return
    const node = emblaApi.rootNode()

    let accumulated = 0
    let cooldownUntil = 0

    const onWheel = (event: WheelEvent) => {
      // Горизонтальный жест трекпадом либо shift+колесо мыши.
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      const delta = horizontal ? event.deltaX : event.shiftKey ? event.deltaY : 0
      if (delta === 0) return

      // Забираем жест себе, иначе Safari уедет «назад» по history.
      event.preventDefault()

      const now = performance.now()
      if (now < cooldownUntil) return

      accumulated += delta
      const threshold = 38
      if (Math.abs(accumulated) < threshold) return

      // Быстрый флик проматывает несколько карточек, медленный — одну.
      const steps = Math.min(3, Math.floor(Math.abs(accumulated) / threshold))
      const target = emblaApi.selectedScrollSnap() + Math.sign(accumulated) * steps
      emblaApi.scrollTo(clamp(target, 0, emblaApi.scrollSnapList().length - 1))

      accumulated = 0
      cooldownUntil = now + 130
    }

    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [emblaApi])

  /* ── клавиатура ── */

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!emblaApi) return
    const last = emblaApi.scrollSnapList().length - 1

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        emblaApi.scrollPrev()
        break
      case 'ArrowRight':
        event.preventDefault()
        emblaApi.scrollNext()
        break
      case 'Home':
        event.preventDefault()
        emblaApi.scrollTo(0)
        break
      case 'End':
        event.preventDefault()
        emblaApi.scrollTo(last)
        break
      case 'PageUp':
        event.preventDefault()
        emblaApi.scrollTo(clamp(emblaApi.selectedScrollSnap() - 3, 0, last))
        break
      case 'PageDown':
        event.preventDefault()
        emblaApi.scrollTo(clamp(emblaApi.selectedScrollSnap() + 3, 0, last))
        break
      default:
        break
    }
  }

  const focusIndex = useCallback(
    (index: number) => {
      if (!emblaApi) return
      if (emblaApi.selectedScrollSnap() === index) return
      emblaApi.scrollTo(index)
    },
    [emblaApi],
  )

  return (
    <div className={className}>
      <div
        className="embla-viewport"
        ref={emblaRef}
        role="group"
        aria-roledescription={fits ? undefined : translate('model.carousel.description')}
        aria-label={ariaLabel}
        tabIndex={fits ? undefined : 0}
        onKeyDown={fits ? undefined : onKeyDown}
        data-fits={fits || undefined}
      >
        <div className="embla-container px-[6vw]">
          {items.map((item, index) => (
            <div className="embla-slide" key={item.key}>
              <div className="embla-tween h-full origin-center will-change-transform">
                {item.render({
                  isSelected: index === selected,
                  focusIndex: () => focusIndex(index),
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {fits ? null : <div className="mt-3 flex items-center justify-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={!canPrev}
          onClick={() => emblaApi?.scrollPrev()}
          aria-label={translate('model.carousel.previous')}
        >
          ←
        </Button>

        <div className="flex items-center gap-1" role="tablist" aria-label={translate('model.carousel.position')}>
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={index === selected}
              aria-label={translate('model.carousel.item', { index: index + 1, count: items.length })}
              onClick={() => emblaApi?.scrollTo(index)}
              className={cx(
                'h-1.5 rounded-full transition-all duration-200',
                index === selected
                  ? 'w-5 bg-accent'
                  : 'w-1.5 bg-control hover:bg-muted',
              )}
            />
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          disabled={!canNext}
          onClick={() => emblaApi?.scrollNext()}
          aria-label={translate('model.carousel.next')}
        >
          →
        </Button>
      </div>}
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
