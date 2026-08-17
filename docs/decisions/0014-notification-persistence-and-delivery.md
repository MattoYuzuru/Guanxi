# ADR-0014: Notification persistence, policy и at-most-once delivery

**Статус:** accepted  
**Дата:** 2026-08-18  
**Уточняет:** D-021 Completion notifications

## Context

Notification history, unread state и browser sound — разные обязанности. Если
delivery policy решает, создавать ли row, `off` теряет audit history. Если
`readAt` используется как sound dedup, чтение в одной tab может сломать delivery
в другой. Replay/SSE/reload также способны повторить звук.

## Decision

### Durable row

Первый canonical переход Job в
`completed | failed | cancelled | interrupted` атомарно создаёт ровно одну
content-free Notification row. Unique owner — Job ID. Existing terminal Jobs до
cutover не backfill-ятся.

Row хранит ID, Job ID, terminal outcome, safe navigation projection, effective
policy, created time и global `readAt`. Она не хранит prompt, answer, reasoning,
tool output, raw error, path или secret.

### Policy

Global delivery default — `when_background`. Chat override:
`inherit | off | when_background | always`. Отдельный global sound enable по
умолчанию `false`; он меняется только explicit user action. Effective policy
фиксируется при terminal transition. `off` сохраняет row, но не даёт unread
badge, announcement или sound.

### Background и sound

В Phase 4 Job background, когда ни одна visible tab того же browser profile не
показывает exact Job/Chat. Tabs публикуют presence через `BroadcastChannel`.
CLI/TUI не участвуют в browser presence.

Sound воспроизводит только Web после явного Enable/Preview permission action.
Service, CLI и TUI всегда silent. `completed`, `failed`, `interrupted` sound-
eligible; `cancelled` visual-only. Permission denial не убирает visual state.

Для каждого `(notificationId, channel)` service атомарно выдаёт один durable
claim. Это at-most-once: crash после claim может пропустить sound, но reload,
reconnect и competing tab не повторят его. Read state и claim независимы.

## Invariants

- одна new terminal Job — ровно одна row;
- migration не изобретает исторические rows;
- delivery policy не меняет terminal Job state и existence row;
- `off` не раскрывает notification через badge/sound;
- read/unread глобален, delivery claim channel-specific;
- notification и diagnostics не содержат private work content;
- visual equivalent доступен при любом sound/permission outcome;
- reload/replay/concurrent tabs не дублируют channel delivery.

## Failure и recovery

- Notification insert failure откатывает terminal transition целиком.
- Lost response после mark-read безопасно повторяется.
- Lost response после delivery claim повторно возвращает already-claimed; sound
  может быть пропущен, но не продублирован.
- BroadcastChannel недоступен: policy fail-safe считает exact view unknown и не
  воспроизводит `when_background` sound; visual row остаётся.

## Consequences

Content-free history остаётся полной даже при silent policy. At-most-once
предпочитает редкий missed sound duplicate-звуку. Cross-tab presence остаётся
browser-local и не обещает OS-wide foreground detection.

## Alternatives

- Не создавать row при `off`: отклонено, потому что policy уничтожает историю.
- Использовать `readAt` для dedup: отклонено, потому что read и delivery разные.
- Browser-local localStorage flag: отклонён из-за races и multi-tab duplicate.
- At-least-once sound: отклонён из-за replay/reload annoyance.

## Validation

- exact row counts для всех terminal/non-terminal/retry/recovery paths;
- v-old → v-new migration оставляет old terminal Jobs без notifications;
- policy matrix global/override/outcome/view/permission имеет direct assertions;
- competing visible tabs получают один claim; reload/reconnect не повторяют;
- denial/unsupported BroadcastChannel оставляют accessible visual state;
- payload/redacted diagnostics проходят denylist и structured-schema assertions.
