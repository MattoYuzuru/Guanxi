# ADR-0011: Server-owned feature flags

**Статус:** implemented, locally validated

**Проверено:** 2026-08-09

## Context

Phase 2 slice P2-N должен дать P2-O один безопасный infrastructure input, не
меняя Resource Governor и не обещая measured parallelism. Текущие settings
persisted в SQLite и доступны на запись из Web, но такой scope здесь создавал бы
лишнюю durable policy и скрытый путь включения runtime behavior. Remote flag
provider также противоречил бы local-first boundary и не нужен для одного
зарезервированного consumer.

Node.js предоставляет environment процесса через `process.env`; изменения этого
объекта относятся только к текущему process и не являются внешней
конфигурационной транзакцией. Поэтому runtime не должен перечитывать env на
каждом request или изображать live update. Источник:
[Node.js 22 `process.env`](https://nodejs.org/docs/latest-v22.x/api/process.html#processenv).
Strict Zod objects отклоняют неизвестные поля вместо молчаливого удаления:
[Zod 3 `.strict()`](https://v3.zod.dev/?id=strict).

## Decision

P2-N вводит один typed registry, принадлежащий application server.

- **Build scope:** compiled declaration задаёт closed key, schema/declaration
  version, boolean safe default, operator env name и client visibility.
- **Process/operator scope:** при создании `AppContext` registry один раз снимает
  injected environment snapshot. Разрешены только exact значения `enabled` и
  `disabled`; whitespace, другой регистр и boolean-like aliases invalid.
- **Persisted local setting:** в P2-N отсутствует. Нет migration, settings key,
  localStorage, write API или UI toggle. Если будущий consumer потребует durable
  user choice, это отдельный additive slice с migration/reopen/rollback contract.
- **Precedence:** валидный exact operator override выше compiled safe default.
  Missing value выбирает safe default. Invalid или unavailable operator source
  также выбирает safe default и сохраняет диагностируемое state/reason.
- **Restart semantics:** snapshot immutable. Изменение env применяется только
  после controlled process restart; API не сообщает live update.
- **Mutation authority:** только operator, который запускает server process.
  Web/CLI в этом slice имеют лишь redacted read projection.
- **Projection:** публикуются только client-readable declarations: declared key,
  effective boolean, resolution state, effective source, observation time и
  registry/declaration version basis. Env variable name, raw value, arbitrary
  environment и server-only declarations наружу не выходят.

Первый и пока единственный product declaration —
`estimated_parallel_admission_policy`. Он default-off и только резервирует input
для P2-O. P2-N не читает этот value в Governor и не меняет runtime behavior.

## Invariants

1. Registry keys и declarations централизованы; consumers не используют raw
   string key или `process.env`.
2. Unknown key/schema/state/value и duplicate declaration fail closed.
3. Invalid/unavailable source никогда не включает default-off feature.
4. Public projection не раскрывает raw env, env name или server-only declaration.
5. Registry не выполняет network, analytics, persistence, model или Governor
   side effect.
6. Два `AppContext` получают независимые immutable snapshots без global mutable
   registry state.

## Consequences

- P2-O сможет зависеть от typed effective value и объяснять его provenance.
- Operator меняет policy только через restart, что явно и предсказуемо, но менее
  удобно, чем будущий persisted UI setting.
- Additive read route совместим со старыми clients; отсутствие route в старом
  server остаётся обычной version capability boundary.
- Rollback удаляет additive route/registry; пользовательских данных и migration
  для восстановления нет.

## Alternatives

- **SQLite settings/write UI:** отложено — P2-N не имеет принятого owner choice о
  durable user mutation и не должен расширять policy surface.
- **Remote/SaaS flags:** отклонено — добавляет network, identity и availability
  boundary без необходимости.
- **Чтение env в consumer:** отклонено — разбрасывает keys, делает restart
  semantics неочевидной и создаёт global test leakage.

## Validation

- exact contract parsing, future/unknown/extra rejection и duplicate count;
- registry completeness, unique key и default-off declaration;
- default/operator precedence, stable startup snapshot, invalid/unavailable
  fallback;
- redacted read projection и два независимых application requests;
- explicit assertions об отсутствии persistence/network/Governor side effects.
