# ADR-0003: Capability evidence и task adapters

**Статус:** proposed  
**Дата:** 2026-08-02

## Context

Типов моделей и modalities больше, чем можно поддержать hardcoded ветками.
Metadata неоднородна: runtime declarations, provider tags и model cards не
гарантируют качество или совместимость. Ollama не публикует универсальную schema
всех STT/TTS/image/video параметров.

## Decision

Ввести:

1. `ModelDescriptor` и exact `ModelVariant`;
2. `OperationDescriptor` с typed inputs/outputs/streaming/parameter schema;
3. appendable `CapabilityEvidence` с provenance/confidence/fingerprint;
4. `TaskAdapter` для provider protocol и Artifact mapping;
5. specialized Workbench для common operations и JSON-Schema fallback.

Статусы: verified, declared, claimed, degraded, unknown, overridden. Absence
metadata остаётся unknown.

## Invariants

- fit относится к digest/configuration;
- provider/model-card claim не равен runtime proof;
- semantic quality не autodetect по tags;
- user override всегда маркирован;
- probe cache включает runtime/backend/hardware/probe version;
- Workbench не ветвится по substring имени модели.

## Consequences

Плюсы:

- новые operations добавляются adapter, а не переписыванием всей IA;
- long tail имеет безопасный fallback;
- UI объясняет доступность;
- можно постепенно поддержать STT/TTS/OCR/media.

Минусы:

- manifest/evidence сложнее простого enum;
- controlled probes требуют resource budget;
- generic schema UI уступает handcrafted experience;
- некоторые модели навсегда останутся unknown.

## Alternatives

- фиксированные категории «text/image/audio»: не покрывают multimodal/any-to-any.
- один огромный JSON input: технически универсален, но плох для common flows.
- доверять model card: создаёт ложные обещания.

## Validation

- chat и transcription реализуются разными adapters на одном Job contract;
- неизвестная operation рендерится schema fallback;
- conflicting evidence видимо;
- stale evidence invalidates при изменении digest/runtime.
