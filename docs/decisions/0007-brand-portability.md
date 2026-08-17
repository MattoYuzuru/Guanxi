# ADR-0007: Переносимый brand и совместимое переименование

**Статус:** accepted

**Дата:** 2026-08-02

**Уточнено:** D-029 принимает `alamo` как target canonical command и требует
полной замены visible brand при будущем rename; старые identifiers остаются
только как compatibility migration layer.

## Context

`Alamo` — рабочее имя. Сейчас оно встречается в UI, packages, CLI executable,
DB/data path, localStorage, CSS и diagnostics. Простая массовая замена сломает
существующие installs и данные.

## Decision

Разделить:

- display brand;
- stable internal product ID;
- npm/package names;
- CLI canonical command и aliases;
- data directory/schema identity;
- config/env prefix;
- browser storage namespace.

Ввести central brand manifest для display strings/assets. Rename выполняется
compatibility migration:

1. новый display name;
2. новый CLI alias рядом со старым;
3. discovery старого data path;
4. atomic/copy migration с backup и marker;
5. localStorage key migration;
6. deprecation window для packages/env;
7. diagnostics показывают migration source.

## Invariants

- display name не используется как DB/API identity;
- старые user data не теряются;
- migration идемпотентна;
- rollback до проверки сохраняет старый path;
- новые feature components не hardcode brand.

## Consequences

Плюсы:

- будущее имя меняется централизованно;
- existing installs продолжают работать;
- packages и data могут мигрировать независимо.

Минусы:

- некоторое время поддерживаются aliases;
- central manifest не устранит уже существующие IDs автоматически;
- npm rename зависит от publication strategy.

## Alternatives

- search/replace: ломает paths/keys/packages.
- навсегда оставить visible/internal Alamo после rebrand: заменено D-029;
  старое имя допустимо только во временном compatibility/migration layer.

## Validation

- fixture старой установки открывается новым binary;
- повторный migration no-op;
- downgrade/rollback описан;
- `rg` не находит новые hardcoded display strings вне manifest/tests.
