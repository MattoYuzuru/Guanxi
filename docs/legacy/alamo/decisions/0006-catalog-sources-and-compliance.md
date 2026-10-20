# ADR-0006: Catalog providers, provenance и compliance

**Статус:** accepted

**Дата:** 2026-08-02

## Context

Текущий `ollama.com/api/search` отвечает 404. Human search page не является
документированным API. Актуальные Ollama Terms запрещают автоматический доступ
без разрешения и использование сервиса для competing products. Hugging Face даёт
официальный API, но metadata и Ollama compatibility не являются runtime proof.

## Decision

Каталог строится из provider adapters с явной policy:

1. installed models: documented local `/api/tags` + `/api/show`;
2. running state: `/api/ps`;
3. локальный version-gated recommendations cache — только как optional curated
   source с experimental label;
4. Hugging Face public API — discovery, exact GGUF download и provenance;
5. bundled/manual dated snapshot — offline fallback;
6. user-supplied Ollama model name/page URL → normalized reference → local pull;
7. Ollama full live catalog и scraping не реализуются;
8. официальный human catalog открывается внешней ссылкой.

Каждая запись показывает source, fetchedAt, stale state, installability и
runtime-verification отдельно.

## Invariants

- никакого HTML/undocumented endpoint scraping, включая one-time snapshot job;
- catalog claim не равен pull compatibility;
- stale provider не ломает installed list;
- provider response schema validated;
- timeouts, AbortSignal, bounded concurrency и backoff обязательны;
- gated/license state видим до download.

## Consequences

Плюсы:

- юридически и технически устойчивее;
- honest offline behavior;
- несколько источников без смешения confidence;
- можно развивать advanced filters.

Минусы:

- полный Ollama catalog отсутствует, пока upstream не даст разрешённый API;
- HF results требуют deduplication и verification;
- provider maintenance остаётся.

## Alternatives

- scrape Ollama search: отклонено по policy и fragility.
- только bundled 10 models: слишком бедный discovery.
- только HF: не гарантирует Ollama pull.

## Validation

- network-offline и provider-failure tests;
- источник/freshness видимы;
- model variant нельзя назвать verified до runtime evidence;
- правовой review обновляется при смене provider terms.
