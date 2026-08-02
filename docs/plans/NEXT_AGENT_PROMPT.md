# Prompt следующему агенту

**Назначение:** Phase 0, slice P0-A — Web crash containment  
**Статус:** ready  
**Проверено:** 2026-08-02

Скопируйте текст ниже в новую coding-agent сессию.

---

Работай в репозитории Alamo UI. Продолжи текущую Phase 0, но реализуй только
bounded slice `P0-A Web crash containment`.

Обязательный порядок:

1. Полностью прочитай `AGENTS.md`, затем `docs/NAVIGATION.md`,
   `docs/plans/PHASE_STATUS.md`, Phase 0 в `docs/plans/ROADMAP.md`,
   `docs/architecture/RUNTIME_LIFECYCLE.md` и accepted ADR-0004.
2. Проверь Git status и сохрани unrelated/untracked user files. Не изменяй `.idea`.
3. Используй:
   - `sde-agent:implementation-planning` и `sde-agent:sde-agent` как owner;
   - `frontend-agent:frontend-agent` и `frontend-agent:frontend-verification`
     для React/Error Boundary/accessibility;
   - `sre-agent:finding-validation` либо `sre-agent:verification-strategy` для
     независимой проверки regression.
4. Сначала составь bounded implementation plan с failure cases, затем реализуй.

Scope P0-A:

- исправить invalid effect cleanup в streaming Chat, не возвращая результат
  `scrollIntoView` из `useEffect`;
- добавить root Error Boundary, который вместо white screen показывает понятную
  ошибку, correlation/diagnostic details, Reload и безопасную навигацию;
- проверить feature boundaries вокруг Chat;
- добавить deterministic web test, который воспроизводит несколько streaming
  phase updates и гарантирует отсутствие `TypeError: ... is not a function`;
- по возможности покрыть create Chat → redirect → first streaming render, но не
  расширяй slice до durable Jobs/status DB migration — это P0-B;
- сохранить keyboard, screen-reader и reduced-motion behavior.

Non-goals:

- не реализовывать весь Job Engine;
- не менять product IA/theme;
- не добавлять Marketplace/media/agent features;
- не скрывать server empty-assistant defect как будто он исправлен.

Validation:

- targeted web/component/browser tests;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- self-review diff;
- независимая frontend/SRE verification.

После успешной проверки:

- обнови current-state docs и только строку P0-A в `PHASE_STATUS.md`;
- зафиксируй остаточные риски;
- полностью перепиши `NEXT_AGENT_PROMPT.md` в готовый bounded prompt для
  следующего незавершённого slice (`P0-B`), включая skills, scope, non-goals,
  validation и ожидаемое обновление статуса;
- сделай небольшие conventional commits, например behavior и test/docs отдельно;
- не помечай Phase 0 завершённой.

Если P0-A заблокирован или обязательная проверка не прошла, не переключай handoff
на P0-B: оставь `NEXT_AGENT_PROMPT.md` на P0-A и добавь blocker, evidence и
безопасные recovery steps.

В финале сообщи commits, доказательства, непройденные проверки и название slice,
для которого подготовлен `NEXT_AGENT_PROMPT.md`.

---
