# Phase status

**Статус документа:** implemented tracker  
**Проверено:** 2026-08-02  
**Текущая фаза:** Phase 0 — Stabilize the truth

Этот файл — короткий mutable tracker. Канонический scope/exit gates находятся в
[`ROADMAP.md`](ROADMAP.md); решения — в
[`2026-08-02-product-decisions.md`](../decisions/2026-08-02-product-decisions.md).

Статусы: `not started`, `in progress`, `blocked`, `implemented`,
`independently verified`.

## Phase 0

| Slice                             | Статус                 | Outcome                                                  |
| --------------------------------- | ---------------------- | -------------------------------------------------------- |
| P0-A Web crash containment        | independently verified | `f038b5c`/`d05a906`; 3 component, 2 Chromium; all checks |
| P0-B Truthful turn terminal state | independently verified | `c673227..7721ca0`; 23 targeted, 76+10 root, 5 Chromium  |
| P0-C Exclusive inference bridge   | not started            | global mutex; compaction conflict/sequence fixed         |
| P0-D Runtime/catalog health       | not started            | real health, no dead endpoint, running models, timeouts  |
| P0-E Browser regression gate      | not started            | create/send/stream/done/reload and failure E2E           |

Phase 0 становится `independently verified`, только когда все slices выполнены и
exit gate ROADMAP проверен целиком.

## Later phases

| Phase                                   | Статус      |
| --------------------------------------- | ----------- |
| Phase 1 — Durable Jobs/Governor         | not started |
| Phase 2 — Models/Capability/import      | not started |
| Phase 3 — Text/Projects/retention/i18n  | not started |
| Phase 4 — Service/CLI/TUI               | not started |
| Phase 5 — First-party coding Agent      | not started |
| Phase 6 — Audio                         | not started |
| Phase 7 — Vision/OCR/image              | not started |
| Phase 8 — Deliberate long-running Agent | not started |
| Phase 9 — Packaging/hotkey/rebrand      | not started |

## Update protocol

После каждого implementation slice агент:

1. обновляет только свой статус и краткое evidence;
2. ссылается на commit/tests;
3. не переводит всю фазу в implemented по одному happy path;
4. оставляет `blocked` только с конкретной причиной и следующим действием;
5. синхронизирует current-state docs, если поведение изменилось;
6. переписывает `NEXT_AGENT_PROMPT.md` для следующего незавершённого slice.

Если текущий slice заблокирован или обязательная проверка не пройдена,
`NEXT_AGENT_PROMPT.md` остаётся на нём и содержит blocker, собранное evidence и
безопасные recovery steps. Переход к первой работе следующей фазы разрешён только
после полного exit gate и independent verification текущей.
