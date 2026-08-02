# Открытые продуктовые решения

**Статус:** proposed  
**Проверено:** 2026-08-02  
**Назначение:** вопросы для следующего обсуждения, не блокирующие документацию

Для каждого вопроса указан рекомендуемый default. Подтверждение пользователя
переводит связанный ADR/требование в `accepted`.

## Решить до Phase 1

### Q-01. Главный продуктовый приоритет

**Рекомендация:** resource-aware workbench/control plane; generic chat parity —
необходимая основа, но не differentiator.

Альтернатива: сначала копировать весь Open WebUI/LM Studio surface.

Почему важно: определяет, инвестируем ли первые месяцы в Governor/Jobs/provenance
или в большое число видимых features. Поздняя смена создаёт архитектурный долг.

### Q-02. Что делать Job при навигации

**Рекомендация:** всегда продолжать в background; спрашивать только при запуске
конфликтующей работы.

Альтернатива: предупреждать при каждом уходе и останавливать по подтверждению.

Почему важно: первая модель делает UI route независимым и лучше соответствует
долгим задачам.

### Q-03. Default concurrency

**Рекомендация:** один accelerator Job, очередь; safe parallel только advanced
после measured fit.

Альтернатива: доверять очереди Ollama и разрешать все submits.

Почему важно: определяет safety promise на 16 GB Mac и простоту scheduler.

### Q-04. Кто владеет Ollama daemon

**Рекомендация:** Alamo управляет своим service и loaded models, но не завершает
внешний Ollama daemon без отдельной явной команды.

Альтернатива: считать Ollama дочерним процессом Alamo.

Почему важно: Ollama может использоваться другими приложениями; `Exit` не должен
ломать их.

## Решить до Phase 2

### Q-05. Full Ollama Marketplace

**Рекомендация:** запросить permission/официальный API; до этого local + HF hints

- dated snapshot + external link, без scraping.

Нужное действие пользователя: решить, готов ли проект обращаться к Ollama за
разрешением и позиционировать ли себя потенциально competing product.

Почему важно: текущие Terms — blocker автоматического human-catalog access.

### Q-06. Direct Hugging Face import

**Рекомендация:** сначала discovery и ссылки; прямой import только для
проверенного GGUF/Ollama adapter и отдельного gated-token flow.

Альтернатива: считать любой `apps=ollama` result installable.

Почему важно: license, gated models, variants и runtime compatibility.

### Q-07. Первая поддерживаемая platform matrix

**Рекомендация:** macOS Apple Silicon как verified tier; NVIDIA PC как второй
prototype/verified tier после уточнения OS.

Нужно уточнить: NVIDIA-компьютер работает под Linux, Windows/WSL или обеими
средами?

Почему важно: telemetry, packaging, process control и filesystem security
существенно различаются.

## Решить до Phase 3

### Q-08. Project и filesystem

**Рекомендация:** Project — логический контейнер; filesystem root — отдельная
привязка с permission.

Альтернатива: каждый Project обязан быть одной папкой.

Почему важно: voice/image personal projects не обязаны иметь source tree, а agent
должен иметь явную границу.

### Q-09. Retention Quick Run

**Рекомендация:** история выключена, временные assets удаляются по TTL; кнопка
Save создаёт Artifact/Chat entry.

Альтернатива: локальная история всех диктовок по default, как в специальных apps.

Нужно уточнить: важнее приватность/чистота или удобная automatic history?

### Q-10. Thinking storage/privacy

**Рекомендация:** показывать live при наличии отдельного channel; сохранять только
по явной global/Project policy, экспортировать отдельно.

Альтернатива: всегда сохранять рядом с answer.

Почему важно: thinking может быть большим, приватным и не предназначенным для
долгого хранения.

### Q-11. Названия сущностей

**Рекомендация:** UI: Quick Run, Chat, Project, Recipe, Agent Run, Artifact.

Нужно проверить русские/английские labels и понять, подходит ли слово `Recipe`.
Возможная альтернатива: Preset/Profile, но нельзя одновременно использовать все
три как разные сущности.

## Решить до Audio/Media

### Q-12. Первый specialized adapter

**Рекомендация:** STT/Dictation после text foundation: он проверяет upload,
stream/progress, vocabulary, pipeline и resource switching.

Альтернатива: image generation как более визуальный showcase.

### Q-13. Voice capture surface

**Рекомендация:** сначала browser record/upload; global OS hotkey — отдельная
desktop integration phase.

Почему важно: настоящий system-wide hotkey ненадёжен в обычном browser.

### Q-14. Cleanup и summary transcript

**Рекомендация:** raw transcription, cleanup и summary — отдельные видимые stages
Recipe pipeline.

Альтернатива: speech model silently возвращает «улучшенный» текст.

Почему важно: сохраняет provenance и не приписывает STT capability того, что
сделал LLM.

### Q-15. Video

**Рекомендация:** оставить P3/experimental до реального stable adapter/provider.

Нужно уточнить, является ли video личным приоритетом или лишь требованием не
закрывать архитектуру.

## Решить до Agent/CLI

### Q-16. Собственный agent harness

**Рекомендация:** сначала запуск/interop Claude Code, Codex, OpenCode через
совместимый локальный endpoint; свой harness — только ради durable deliberate
mode.

Нужно уточнить: какой первый agent use case — coding, deep research, file
automation или general assistant?

### Q-17. Weak-model deliberate mode

**Рекомендация:** явный execution profile с budget/checkpoints/verifier.

Нужно определить benchmark: одна реальная ночная coding/research задача, критерии
качества, максимальное время и разрешённые tools.

### Q-18. MCP/Skills default

**Рекомендация:** deny-by-default для mutating/network/secret effects; bindings
на Project/Recipe; Chat/Job может только сузить или запросить расширение.

Нужно уточнить, какие MCP должны быть first-party в первой версии.

### Q-19. TUI и service autostart

**Рекомендация:** no-args TUI; `start --detach` явный; autostart/login item
выключен до opt-in.

Нужно уточнить, должен ли service переживать закрытие terminal и автоматически
стартовать после login.

## Naming/visual

### Q-20. Новое название

**Рекомендация:** сначала centralize и migration-ready boundaries, затем branding
exercise; не переименовывать packages/data path в середине runtime rewrite.

Нужно получить short list названий, tone и требования к домену/trademark.

### Q-21. Font

**Рекомендация:** JetBrains Mono для technical UI, readable sans для длинного
content; full-mono как настройка.

Нужно подтвердить, хочет ли пользователь JetBrains Mono абсолютно везде даже для
длинных Markdown-документов.
