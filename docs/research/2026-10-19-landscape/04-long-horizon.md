# 04 — Long-horizon agents: context management, relay handoff, strong planner / weak executor, multi-agent org, judges, ETA

**Статус:** proposed (research input, не решение и не реализация)
**Дата исследования / доступа к источникам:** 2026-10-19
**Область brief:** C1–C9 (ядро), D6, J1–J2
**Репозиторий-контекст (read-only):** `the Guanxi repository` @ `116e104` — ADR-0010
(first-party coding agent, deliberate profile), Q-27 (только time-based limits, `wrap up and
report`, stall detector), ROADMAP Phase 8, `RUNTIME_LIFECYCLE.md` (immutable compaction
checkpoint: summary + exact source evidence, original history не удаляется).

---

## 0. TL;DR

1. **Relay handoff — правильная базовая идея, но не в виде «summary-of-summary».** Доказательства
   (Amp [10], Factory [17], ACE [19], self-conditioning [66]) говорят: свободная
   LLM-summary теряет детали и дрейфует от цикла к циклу, а file/artifact trail — самое слабое
   место всех методов компрессии (Factory: 2.2–2.45 из 5 [17]). Поэтому handoff должен на
   ~70% состоять из **детерминированного ledger, который ведёт harness** (task tracker,
   git HEAD/diff, files touched, последние результаты тестов, счётчики ошибок), плюс
   **append-only заметок агента** (decisions, dead ends, lessons) и лишь небольшой
   **narrative delta**, которую модель пишет в момент handoff.
2. **Пороги 75%/90% надо вычислять в токенах из резервов, а не задавать процентом.** Для окна
   32k при резерве на ответ 4k и на handoff+tool output ~5.5k «поздний» порог получается ≈68%, для 64k — ≈80%.
   Плюс отдельный cap «эффективной длины» модели (RULER/NoLiMa/Context Rot: качество падает
   задолго до номинального окна [3][61][62]). И главное — **handoff на границе задачи**
   (после каждого закрытого task item при заполнении > ~50%) лучше, чем по давлению токенов
   — вывод [I] из практики Anthropic harness [2] и Amp [10]; контролируемого сравнения нет,
   его надо получить своим benchmark (§10).
3. **Свежий контекст — не только «вынужденная мера», а инструмент качества**: модели
   самообусловливаются на собственных ошибках в контексте [66], деградируют в длинных
   multi-turn диалогах [24] и на длинных входах [3]. Короткие сфокусированные циклы с
   чистым стартом — то, что в принципе может дать «без деградации», если state передаётся
   надёжно.
4. **Слабый исполнитель успешен только на мелких проверяемых шагах.** Для open-weight моделей
   ≤80B METR не измерял time horizon вообще; ближайшая по размеру измеренная open-модель
   (gpt-oss-120b) — ~45 мин p50 и ~8 мин p80, максимум среди open-weight — Kimi K2 Thinking
   (1T MoE) ~58/~15 мин [57]. Значит, strong planner должен резать работу на задачи
   «минуты человеческого труда» с явной командой проверки, а harness — гнать tests/lint/type
   checks как red-flag сигнал (MAKER [67], TDD [53]). Плохой план хуже отсутствия плана [68].
5. **Judge — каскад, а не один LLM.** L0 детерминированные watchdog/heartbeat → L1 эвристики
   зацикливания (как OpenHands StuckDetector) и прогресса по ledger → L2 локальная LLM с
   taxonomy-guided rubric на границах циклов (SWE-PRM: +10.6 п.п. [50]) → L3 эскалация
   сильной модели только на pre-flagged случаях (weak-to-strong monitoring [49], Trust or
   Escalate [48]). Самоотчётам агента о прогрессе/завершении не доверять [2][54][55].
6. **Multi-agent — только там, где работа параллелится и read-heavy**; для связанного
   кодинга — single-threaded executor + централизованная верификация [37][38][40].
   Оргпримитивы: Lead/Planner, Executor, Reviewer, Monitor/Judge, Advisor (on-demand,
   квотированный — аналог Anthropic advisor tool [32]).
7. **Hibernation/wake**: делегированная работа — durable Job с A2A-подобной state machine и
   push-callback; лид будится по `completed | failed(after retries) | input_required |
   host_lost(lease expiry) | judge_escalation | deadline`. Wake packet — компактный отчёт
   + ссылки на evidence, не полный trace.
8. **ETA** — burn-down по плану + Evidence-Based Scheduling (Monte Carlo по историческим
   отношениям estimate/actual для пары model×host) + token-throughput модель из
   `prompt_eval_*`/`eval_*` Ollama; выдавать P50/P80 с источником и confidence. Самооценке
   агента не доверять (оптимистичный bias [54]).

---

## 1. Методика и легенда

- Все источники открыты 2026-10-19 (WebFetch/WebSearch, чтение кода shallow-clone без запуска).
- **Сила доказательства:**
  - **A** — peer-reviewed (ICLR/ICML/NeurIPS/ACL/TACL) или независимо воспроизведённый результат;
  - **B** — preprint с существенными экспериментами, или официальный engineering-пост/доки
    вендора с собственными измерениями (vendor-reported);
  - **C** — практический опыт/позиция без контролируемого эксперимента, единичный источник,
    position paper;
  - **D** — непроверенное/сообщество/вторичный пересказ.
- **Статус проверки:** **[V]** — проверено по первоисточнику в этой сессии; **[I]** —
  вывод/интерпретация автора отчёта или факт только из вторичного источника.
- Preprint с номером arXiv `26xx` — работы 2026 года; почти все не прошли peer review — сила B
  максимум.

---

## 2. Q1 — Context management и compaction

### 2.1 Что говорит evidence

**Длина контекста сама по себе вредит.**
- *Lost in the Middle* (TACL): качество максимально, когда релевантное в начале или в конце
  входа, и проседает в середине, даже у long-context моделей [4] [V].
- *Context Rot* (Chroma, 2025-07-14): 18 моделей, включая Qwen3-8B/32B/235B (YaRN 32k→131k);
  качество падает с ростом входа даже на простых задачах; дистракторы усиливают падение;
  LongMemEval: focused prompt (~300 токенов) лучше полного (~113k) у всех семейств [3] [V].
  Ограничение: авторы не разделяют полностью длину и сложность задачи.
- RULER: только ~половина моделей, заявляющих ≥32k, держат качество на 32k; NoLiMa: 11 из 13
  моделей падают ниже 50% собственного short-context baseline к 32k [61][62] [V через
  отчёт субагента + abstract]. Vendor-RULER для Qwen3-30B-A3B-Instruct-2507: 97.2/93.4/89.1
  на 32k/64k/128k (с DCA) [63] [V, vendor].
- *LLMs Get Lost in Multi-Turn Conversation*: в среднем −39% в multi-turn underspecified
  диалогах; основной вклад — рост unreliability; «когда модель свернула не туда, она не
  восстанавливается» [24] [V].
- *Illusion of Diminishing Returns* (ICLR 2026): точность по шагам падает с длиной задачи;
  **self-conditioning** — модель чаще ошибается, когда в контексте её прежние ошибки; масштаб
  модели это не лечит; thinking-режим смягчает [66] [V].
- *Effective context engineering* (Anthropic, 2025-09-29): контекст — конечный ресурс с
  убывающей отдачей («attention budget»); техники для long-horizon: compaction (сначала
  максимизировать recall, потом precision; tool-result clearing как самая лёгкая форма),
  structured note-taking (NOTES.md, todo), sub-agents, возвращающие сжатый результат
  ~1–2k токенов; just-in-time retrieval по идентификаторам (пути, запросы) [1] [V].

**Как это делают production harness'ы.**
- *Effective harnesses for long-running agents* (Anthropic, 2025-11-26): compaction
  недостаточно; решение — **initializer agent** (первый контекст: `init.sh`,
  `claude-progress.txt`, initial commit, JSON feature list с >200 пунктами, у каждого
  `passes:false`) + **coding agent** на каждый следующий контекст: одна фича за раз, git
  commit, обновление progress-файла, код в mergeable состоянии. Агент может менять только
  поле `passes`; JSON выбран потому, что модель реже «переписывает» его, чем Markdown.
  Startup routine: `pwd` → git log + progress → feature list → `init.sh` + smoke e2e-тест
  до новой работы. Наблюдавшиеся провалы: one-shotting, преждевременное «готово», брошенное
  сломанное состояние, «done» без e2e-теста [2] [V; B — vendor без количественного eval].
- Claude API compaction: threshold-режим (`compact-2026-01-12`, trigger по `input_tokens`,
  default 150k, минимум 50k, `instructions` заменяют дефолтный prompt,
  `pause_after_compaction`) и on-demand (`compact-2026-09-04`; приложение само решает когда;
  «compact before you outgrow it, not after»; повторная compaction суммирует старое summary +
  хвост; изображения/документы в суммированном диапазоне теряются; mid-conversation system
  messages тоже суммируются и перестают действовать) [5][6][7] [V]. Docs прямо говорят, что
  compaction держит активный контекст малым, «because response quality degrades as a
  conversation grows» [5] [V].
- Context editing + memory tool (Anthropic, 2025-09-29): удаление устаревших tool calls/results
  и client-side file memory; во внутреннем eval: +39% (memory+editing), +29% (editing),
  −84% токенов в 100-turn web search [9] [V; B — internal eval].
- Claude Code: auto-compaction при приближении к «auto-compact window» (настраивается
  `autoCompactWindow`), `/compact <focus>` и секция «Compact instructions» в CLAUDE.md [8] [V].
  Точный default-порог официально не документирован; сообщество называет 83–95% и есть
  баг-репорт, что override-переменная игнорируется [64] [D].
- OpenAI GPT-5.1-Codex-Max (2025-11-19): «first model natively trained to operate across
  multiple context windows through … compaction», многочасовые циклы [25] [V через цитату
  Simon Willison; первоисточник вернул 403]. **Вывод [I]:** у frontier-моделей устойчивость к
  compaction частично «вшита» обучением; локальный Qwen такой гарантии не имеет — harness
  должен компенсировать структурой.
- Codex CLI / OpenCode / Cline / Goose / OpenHands / Aider / Letta — детали реализации в §7.
- *Amp Handoff* (2025-10-23): compaction удалена; причины — lossy, «stacking summary on top of
  summary», поощряет длинные блуждающие треды; вместо этого пользователь (позже — сам агент)
  задаёт **цель нового треда**, Amp генерирует стартовый prompt + **список релевантных
  файлов** как черновик для ревью [10][11] [V; C — практика без опубликованного eval].
- Cognition «Don't build multi-agents»: для очень длинных задач — отдельная модель,
  сжимающая историю в «key details, events, decisions» [38] [V; C].

**Контролируемые сравнения стратегий.**
- *The Complexity Trap* (JetBrains, DL4C@NeurIPS 2025): SWE-agent на SWE-bench Verified, 5
  конфигураций (Qwen3-32B ±thinking, Qwen3-Coder-480B, Gemini 2.5 Flash ±thinking).
  **Observation masking** (окно 10 последних ходов, старые observations → placeholder,
  reasoning/actions сохраняются) режет стоимость ~50% и по solve rate не хуже
  LLM-summary (N=21 ход в summary, последние 10 нетронуты). Пример Qwen3-32B: raw 17.0%,
  masking 15.0%, summary 16.0%; Qwen3-Coder-480B: 53.4/54.8/53.8. Summary удлиняет траектории
  на ~13–15% («summary как сигнал продолжать»). Гибрид ещё −7%/−11% стоимости [16] [V; B+].
- *OpenHands condenser*: на полном SWE-bench Verified (100 итераций, v0.21) 200 vs 203 решённых
  без condenser, и **дороже на $40** из-за потери prompt cache; после перехода на триггер по
  размеру (кэш-дружелюбно) блог сообщает 54% vs 53% на подмножестве и до 2× дешевле
  per-turn, линейный рост стоимости вместо квадратичного [13][14] [V; B — vendor].
- *Factory, Evaluating Context Compression* (2025-12-16): 36k+ production-сообщений;
  probe-based eval (recall / artifact / continuation / decision), judge GPT-5.2, 6 измерений.
  Структурированная **anchored iterative summarization** (секции: session intent, file
  modifications, decisions made, next steps; суммируется только новый усечённый span и
  мёржится в существующий) — 3.70 vs Anthropic 3.44 vs OpenAI 3.35; **artifact trail —
  худшее измерение у всех (2.19–2.45)**, «an unsolved problem»; правильная метрика — tokens
  per task, а не compression ratio [17] [V; B — vendor сравнивает себя, judge — LLM].

**Исследовательские подходы (в основном требуют обучения модели).**
- MemGPT/Letta: virtual context management по аналогии с OS memory tiers, interrupts [18] [V; B].
- ACE (ICLR 2026): контекст как эволюционирующий «playbook»; generator/reflector/curator,
  **инкрементальные структурированные обновления** против brevity bias и **context collapse**
  («iterative rewriting erodes details over time»); +10.6% на агентных бенчмарках [19] [V; A].
- ReSum: периодическая суммаризация истории для web-агентов, +4.5% к ReAct без обучения,
  +8.2% с ReSum-GRPO [20] [V; B]. AgentFold (30B-A3B, SFT): проактивный «folding» на двух
  масштабах — granular condensation и deep consolidation подзадач [21] [V; B]. Context-Folding
  (FoldGRPO): branch в подзадачу → fold с кратким итогом, активный контекст ~10× меньше,
  лучше summary-based [22] [V; B]. **Вывод [I]:** без дообучения модели эти идеи переносятся
  как *структура* harness'а: подзадача = отдельный цикл с возвратом короткого итога.
- Recursive Language Models (Zhang, Kraska, Khattab): длинный вход как переменная во внешнем
  окружении (REPL), модель рекурсивно вызывает себя на фрагментах; входы на 2 порядка больше
  окна; RLM-Qwen3-8B +28.3% к базе [23] [V; B]. Полезно для **чтения** больших артефактов
  (логи, диффы, транскрипты) слабой моделью, а не для основного кодинг-цикла [I].

### 2.2 Evidence table (Q1)

| # | Claim | Source | Strength | Check |
|---|---|---|---|---|
| 1.1 | Качество падает с длиной входа даже на простых задачах, у всех 18 моделей вкл. Qwen3 | [3] | B (тех. отчёт, большой прогон 194k вызовов) | V |
| 1.2 | Позиция важна: начало/конец лучше середины | [4] | A | V |
| 1.3 | Эффективная длина контекста часто ≪ заявленной | [61][62] | A/B | V |
| 1.4 | Ошибки в контексте провоцируют новые (self-conditioning), масштаб не лечит | [66] | A (ICLR 2026) | V |
| 1.5 | Multi-turn деградация ~39%, «не восстанавливаются» | [24] | B | V |
| 1.6 | Observation masking ≈ LLM-summary по качеству при ~2× экономии; summary удлиняет траектории | [16] | B+ (workshop, контролируемо, 5 конфигов) | V |
| 1.7 | Summarizing condenser не ухудшает solve rate, но может ломать prompt cache | [13][14] | B | V |
| 1.8 | Структурированная инкрементальная summary лучше свободной; file trail хуже всего | [17] | B (vendor, LLM-judge) | V |
| 1.9 | Итеративное переписывание контекста вызывает context collapse; нужны delta-обновления | [19] | A | V |
| 1.10 | Compaction недостаточно; нужны initializer + progress file + feature list + git + e2e тест | [2] | C/B (vendor практика) | V |
| 1.11 | Handoff с явной целью нового треда лучше «compact до упора» | [10] | C | V |
| 1.12 | Frontier-модели обучены работать через compaction; open-weight — нет гарантии | [25] / I | B / I | V/I |
| 1.13 | Ollama при переполнении `num_ctx` молча обрезает начало промпта | [65] | D (community + FAQ пересказ) | I |

### 2.3 Выводы для C5 (relay executor)

1. **Ledger важнее summary.** Всё, что harness может знать детерминированно (план и статусы,
   files touched, git, тесты, команды, ошибки), не должно зависеть от памяти модели — это
   прямо закрывает «artifact trail» [17] и требование «задача трекается чётко».
2. **Заметки — append-only и типизированные** (decision / dead_end / hypothesis / lesson /
   open_issue), с curation по ID, а не переписыванием целиком [19]; закрытое «распадается»
   в короткие строки (как beads memory decay [35]).
3. **Narrative delta** — единственное, что модель обязана написать при handoff: что делал
   прямо сейчас, следующая 1–3 действия, текущая гипотеза, грабли. Ограничение размера.
4. **Не тянуть сырой хвост ошибок в новый цикл** [66]: в handoff — дистиллят («X не работает,
   потому что Y»), а не логи стектрейсов; сырые логи — по ссылке (just-in-time [1]) [I].
5. **Внутри цикла** — observation masking старых tool outputs (дёшево и не хуже summary [16]),
   а не LLM-summary; LLM-summary — только на границе цикла.
6. **Порядок в новом промпте** — стабильные инструкции в начале, текущая задача и «первое
   действие» в конце (lost-in-the-middle [4]); стабильный префикс ещё и переиспользует KV/
   prompt cache [I].

---

## 3. Q2 — Weak executor + strong planner

### 3.1 Паттерны и что о них известно

- **Plan-and-Act** (ICML 2025): разделение Planner (структурный план) / Executor (действия);
  планировщик обучен на синтетических планах; SOTA 57.58% WebArena-Lite [26] [V; A].
- **ReWOO**: планирование без промежуточных observations → ~5× экономия токенов, +4% HotpotQA,
  перенос «рассуждения» с 175B на 7B через fine-tuning [27] [V; B].
- **LLMCompiler** (ICML 2024): planner строит план вызовов, executor исполняет параллельно; до
  3.7× быстрее, до 6.7× дешевле, до ~9% точнее ReAct [28] [V; A].
- **From Plan to Action** (2026): 21,120 траекторий SWE-agent; стандартный план помогает,
  **периодические напоминания плана** уменьшают нарушения и повышают успех, **плохой план
  хуже, чем никакого** [68] [V; B].
- **NVIDIA «SLMs are the future of agentic AI»**: позиция (value statement), что SLM достаточно
  для многих агентных вызовов, гетерогенные системы и LLM→SLM conversion [29] [V; **C —
  position paper без контролируемых экспериментов**].
- **FrugalGPT**: каскад LLM, до 98% экономии при качестве GPT-4 [30] [V; B]. **RouteLLM**:
  router на preference-данных, >2× экономии без потери качества «in certain cases» [31] [V; B].
- **Advisor pattern** (Anthropic, 2026-04-09): executor (Sonnet/Haiku) сам вызывает Opus-
  advisor, когда упёрся; advisor возвращает план / коррекцию / stop, не вызывает tools,
  `max_uses` ограничивает вызовы; Sonnet+Opus advisor +2.7 п.п. SWE-bench Multilingual при
  −11.9% стоимости; Haiku+advisor 41.2% vs 19.7% на BrowseComp [32] [V; B — vendor].
  **Это ближайший аналог flagship-сценария**, но в API работает внутри одного запроса; для
  Guanxi advisor = отдельный tool, будящий сильную модель через другой Connection [I].
- **MAKER** (2025): 20-disk Hanoi (~1.05M шагов) без ошибок за счёт «один шаг — один агент»,
  first-to-ahead-by-k voting, red-flagging некорректных/слишком длинных ответов; дешёвые
  модели (gpt-oss-20B — 3.58% ошибок на шаг) экономически оптимальны; ограничения:
  декомпозиция задана вручную, план дан, коррелированные ошибки открыты [67] [V через отчёт
  субагента; B].
- **Self-correction без внешнего сигнала не работает** (ICLR 2024) [51] [V; A]; с внешней
  обратной связью — работает (Reflexion: 91% HumanEval [52] [V; A]); **тесты в постановке
  задачи повышают успех** кодогенерации [53] [V; B].
- **Spec-driven development:** GitHub spec-kit (MIT, ~142k★; constitution → specify → plan →
  tasks → implement) [33] [V]; Kiro (AWS, проприетарный [I]): requirements.md / design.md /
  tasks.md, статус задач, dependency graph и «waves» параллельных задач [34] [V].
- **Task trackers для агентов:** beads (MIT, ~28k★; Dolt-backed граф задач, `bd ready` = задачи
  без открытых блокеров, атомарный claim, «memory decay» закрытых задач) [35] [V]; Task Master
  (**MIT + Commons Clause** — не OSI-open source, запрещает продажу/hosted service; PRD → задачи,
  complexity analysis, expand в подзадачи, `next`, зависимости, MCP-сервер) [36] [V].

### 3.2 Бенчмарки малых open-weight моделей (сводка отчёта субагента, проверено выборочно)

| Model | Benchmark | Score | Scaffold | V/I |
|---|---|---|---|---|
| Qwen3.6-27B (dense) | SWE-bench Verified | 77.2 | внутренний, 200k ctx | vendor |
| Qwen3.6-35B-A3B | SWE-bench Verified / Terminal-Bench 2.0 | 73.4 / 51.5 | внутр. / Terminus-2, 256k ctx | vendor |
| Qwen3.6-35B-A3B | Terminal-Bench 2.0 | **24.6** | third-party harness | independent |
| Qwen3-Coder-Next 80B-A3B | SWE-bench Verified | 70.6–71.3 | SWE-Agent/mini/OpenHands, до 300 turns | vendor |
| Devstral Small 2 (24B) | SWE-bench Verified | 68.0 vs **56.4** | не указан vs mini-SWE-agent | vendor vs independent |
| gpt-oss-120b | SWE-bench Verified | 62.4 vs **26.0** | неясен vs mini-SWE-agent | vendor vs independent |
| gpt-oss-20b | Terminal-Bench 2.0 | **3.1** | Terminus 2 | independent |
| Qwen3-Coder-30B-A3B | SWE-bench Verified | 51.6 | OpenHands (submission) | submitter |
| gpt-oss-120b | METR time horizon | ~45 мин p50 / ~8 мин p80 | METR TH1.0 | independent |

Источники: [57][69][73]–[78] (числа собраны субагентом по первоисточникам; vendor-числа
помечены). Важные оговорки: OpenAI перестал считать SWE-bench Verified валидным
(контаминация, дефектные тесты) и оценил ~30% задач публичного SWE-bench Pro как сломанные
[71][72] [V через отчёт субагента по Wayback-снимкам; B]. METR не измерял ни одной модели
≤80B; p80-горизонт в 5–10× короче p50 [57]. Прямого бенчмарка «30B-модель часами
автономно кодит» не найдено [I по отчёту субагента].

Дополнительно: «Coherence Collapse» (2026) — 60–69% провалов агентов доходят до нужных функций,
но дают неверный патч; агенты перезаписывают уже правильный код, edit-checkpoints это
восстанавливают [80] [B, по отчёту субагента]; Vending-Bench — многомиллионные по токенам
прогоны «срываются» в петли, и срывы **не коррелируют** с заполнением окна [81] [B, по отчёту
субагента] → нужен мониторинг поведения, а не только токенов.

**Выводы [I]:**
1. Разрыв vendor vs independent для малых моделей — 10–30 п.п.; формат tools/harness критичен →
   Guanxi обязан иметь собственный локальный eval на своём harness.
2. Vendor-результаты получены при 200–256k контексте и до 300 ходов; 32–64k — вне
   распределения → короткие циклы + relay обязательны, а не опциональны.
3. Задача executor'а ≈ «минуты человеческой работы» (p80 горизонт), а не часы.

### 3.3 Гранулярность задач и верификация для локального кодера (рекомендация)

Каждый task item в плане сильной модели (схема — §8.1, `plan.items[]`):
- **Размер:** выполним за ≤1 relay-цикл с запасом: оценка «чтение + правки + проверка» ≤ ~50%
  бюджета окна; эквивалент «≤15–30 минут работы человека» для 30B-класса [57][66] [I].
- **Контракт:** цель (1–2 предложения), файлы для чтения/изменения (явные пути), интерфейсы/
  сигнатуры, «не трогать», зависимости (`blocked_by`).
- **Acceptance:** исполняемая команда (тест/линт/typecheck/скрипт) + ожидаемый результат;
  тест по возможности пишется *до* реализации (сильной моделью или отдельным item) [53].
- **Evidence:** что сохранить (лог теста, дифф, скриншот), чтобы judge/лид проверили без
  повторного прогона.
- **Escalation hint:** когда звать advisor (например, «если интерфейс X не подходит — stop и
  спросить, не менять контракт»).
- **Неизменяемость плана исполнителем:** executor меняет только `status`/`evidence` и может
  *предложить* amendment (отдельная запись), как `passes`-only в [2] — защита от «declare
  victory» и от дрейфа плана [I].
- Периодически (на каждом цикле) повторять текущий milestone плана в промпте [68].

---

## 4. Q3 — Мульти-агентная организация

### 4.1 Evidence

- **Anthropic multi-agent research** (2025-06-13): orchestrator-worker; Opus 4 lead + Sonnet 4
  subagents +90.2% к single-agent Opus 4 на внутреннем research-eval; токены объясняют ~80%
  вариации на BrowseComp; агенты ≈4× токенов чата, multi-agent ≈15×; **плохо подходит для
  большинства кодинговых задач** и задач с общим контекстом/зависимостями; делегирование:
  цель, формат ответа, tools/источники, границы; сложность → число агентов; ранний eval на ~20
  запросах; LLM-judge по rubric; resume из checkpoint; синхронное ожидание subagents —
  bottleneck [37] [V; B].
- **Cognition «Don't build multi-agents»** (2025-06-12): share full context/traces; действия
  несут неявные решения → конфликт при параллельной записи (пример Flappy Bird); default —
  single-threaded linear agent [38] [V; C].
- **MAST / «Why do multi-agent LLM systems fail?»**: 1,600+ трейсов, 7 фреймворков, 14 failure
  modes в 3 категориях, κ=0.88. Самые частые: step repetition 15.7%, reasoning-action
  mismatch 13.2%, unaware of termination 12.4%, disobey task spec 11.8%, incorrect
  verification 9.1%, no/incomplete verification 8.2%, premature termination 6.2%.
  Тактические фиксы (уточнение ролей, проверка цели) дают +9.4…+15.6% в ChatDev, но не
  закрывают проблему — нужен структурный редизайн [39] [V; B (venue не подтверждён)].
- **Towards a Science of Scaling Agent Systems** (2025-12, 260 конфигураций, 6 бенчмарков, 5
  архитектур): от **+80.8%** на декомпозируемом финансовом reasoning до **−70.0%** на
  последовательном планировании; tool-heavy задачи несут overhead координации; без
  централизованной верификации ошибки распространяются сильнее; убывающая отдача, когда
  single-agent baseline уже силён [40] [V; B].
- Фреймворки (для словаря примитивов, не как зависимость): MetaGPT — SOP/роли/«сборочная
  линия» [41]; ChatDev (ACL 2024) — chat chain по waterfall-фазам [42]; AutoGen — conversable
  agents, **репозиторий в maintenance/архиве, преемник — Microsoft Agent Framework**; AG2 —
  форк [43] [V]; OpenAI Agents SDK — handoff как tool `transfer_to_<agent>`, `input_filter`
  (например, вырезать tool calls), opt-in сжатие истории при handoff; agents-as-tools для
  подзадач без передачи управления [44] [V]; Claude Code subagents — отдельный контекст,
  возвращают только итог, свой model, вложенность до 3 уровней [45] [V].

### 4.2 Когда multi-agent помогает / вредит

| Помогает | Вредит |
|---|---|
| Параллелизуемый read-heavy поиск/исследование [37][40] | Последовательное планирование/сцепленный кодинг [37][38][40] |
| Изоляция «шумного» контекста (логи, доки) с возвратом ≤2k summary [1][45] | Несколько писателей в один артефакт без общего контекста [38] |
| Независимая проверка (reviewer/judge в свежем контексте) [40][47] | Слабый baseline + много координации; токенный бюджет ограничен [37][40] |
| Специализация моделей по цене/возможностям (advisor, cascade) [30][32] | Нет явных условий завершения/верификации (MAST FC1/FC3) [39] |

### 4.3 Рекомендуемые оргпримитивы

- **Lead/Planner** (strong; редко бодрствует): spec, план, acceptance, judge rubric, wake-политика.
- **Executor** (weak/local; single-threaded на один worktree): исполняет items, ведёт notes.
- **Reviewer** (может быть та же локальная модель в свежем контексте + другой system prompt +
  rubric + tool feedback, C7): ревью дифа по item; без tool feedback — слабо [51].
- **Monitor/Judge** (каскад L0–L3, §8.2): наблюдает, не пишет код.
- **Advisor** (strong, on-demand, `max_uses`/квота на Run): отвечает планом/коррекцией/stop
  ≤~700 токенов [32].
- **Scout/Researcher** (опционально, параллельно, read-only): доки/поиск, возвращает summary.

Правило: **один писатель на worktree**; параллелизм — только по независимым items на разных
worktree с resource leases (H6) и централизованной верификацией (merge gate) [40][I].

---

## 5. Q4 — Мониторинг и judging

### 5.1 Evidence

- **LLM-as-a-judge** (MT-Bench/Chatbot Arena, NeurIPS 2023 D&B): GPT-4 >80% согласия с
  людьми (уровень человек-человек); position, verbosity, **self-enhancement** bias, слабость
  в reasoning [46] [V; A]. → Ревью «той же моделью» (C7) уязвимо к self-enhancement [I].
- **Agent-as-a-Judge** (DevAI: 55 задач, 365 иерархических требований): агент-судья с
  инструментами существенно лучше LLM-as-a-judge и сопоставим с людьми; репозиторий MIT
  заявляет ICML 2025 и ~97.7% экономии времени/стоимости против людей [47] [V; B (venue по
  заявлению репо)].
- **Trust or Escalate**: selective evaluation с гарантией согласия с людьми; **cascaded
  selective evaluation** — дешёвый judge сначала, эскалация к сильному только при низкой
  уверенности; Mistral-7B-каскад гарантирует >80% согласия при ~80% покрытия [48] [V; B (ICLR
  2025 по памяти, не подтверждено)].
- **Weak-to-strong monitoring**: гибридный иерархически-последовательный scaffold позволяет
  слабым мониторам надёжно следить за сильными агентами; осведомлённость агента о мониторинге
  снижает надёжность; человек, смотрящий только pre-flagged случаи, +~15% TPR при FPR 0.01
  [49] [V; B].
- **SWE-PRM** (inference-time PRM): вмешивается во время исполнения по таксономии
  неэффективностей (redundant exploration, looping, failure to terminate); SWE-bench Verified
  40.0% → 50.6%; **taxonomy-guided feedback лучше неуправляемого и «предписывающего
  действие»**; короче траектории; доп. стоимость от $0.2 [50] [V; B].
- **Outcome prediction классификаторами**: per-task дискриминаторы по эмбеддингам траекторий
  до 0.95 AUROC; ранние уверенные предсказания успеха [56] [V; B, 2026-10 preprint, свежий].
- **Самоотчёты ненадёжны:** агенты переоценивают выполнимость (на провальных траекториях >70%
  «feasible» после 60% бюджета; тревога — только в последних 20%) [54]; «frameworks should not
  control task flow on the strength of the model's state reports alone» [55]; premature
  victory у Claude в [2] [V; B].
- **MAST**: step repetition (15.7%) и unaware of termination (12.4%) — топ причин провалов [39].
- Stuck/loop эвристики в коде OpenHands, Cline, Goose и др. — §7.

### 5.2 Выводы

1. Исполняемые проверки (тесты, build, typecheck, линт, e2e) — первичный judge; LLM-judge —
   вторичный и для того, что тестами не ловится (дрейф от плана, бессмысленные обходы,
   «тест подогнан»).
2. Judge должен давать **таксономический диагноз**, а не «сделай X» [50].
3. Дешёвое (детерминированное/классификатор/локальная LLM) — всегда; дорогое (strong model) —
   только на флагах [48][49].
4. Completion = gates пройдены + evidence, а не «агент сказал done» [2][55].

---

## 6. Q5 — ETA и оценка прогресса

- **METR time horizon:** логистическая регрессия P(success) от log(human time), horizon =
  длина задачи при 50%/80% успеха; удвоение ~7 мес (2019–2025), в TH1.1 (2026-01-29) — 131
  день после 2023 и ~89 дней с 2024; p80 в 4–10× короче p50; оговорки: «messy» задачи
  сложнее, оценки >16 ч ненадёжны [57] [V через отчёт субагента + arXiv; A/B]. Для Guanxi это
  **метод калибровки**, а не ETA: прогнозирует вероятность успеха item'а по его оценке в
  человеко-минутах [I].
- **Evidence-Based Scheduling** (Spolsky 2007): задачи ≤16 ч, velocity = estimate/actual,
  Monte Carlo по историческим velocity → распределение дат [70] [V; C — инженерная практика,
  широко применяемая, без академической валидации].
- **Self-estimation агентов**: BAGEN — оптимистичный bias и поздние тревоги; SFT+RL помогают,
  но покрытие интервалов ≤47% [54]; Unreliable Progress Bar — надёжность самоотчёта зависит от
  стадии [55] [V; B, 2026 preprints]. T2SPO / Precog-RM — регрессоры «оставшегося расстояния»
  по траекториям [56] [V для Precog-RM; B].
- **Token/throughput модель:** Ollama возвращает `prompt_eval_count`, `prompt_eval_duration`,
  `eval_count`, `eval_duration`, `total_duration` [65] [V] — достаточно для оценки
  tok/s prefill/decode на конкретном host×model.

**Рекомендуемый ETA-estimator** — §8.5.

### 6.1 Evidence table (Q2–Q5)

| # | Claim | Source | Strength | Check |
|---|---|---|---|---|
| 2.1 | Разделение planner/executor повышает успех long-horizon web-задач | [26] | A | V |
| 2.2 | План без observations экономит токены и позволяет малой модели исполнять | [27][28] | A/B | V |
| 2.3 | Плохой план хуже отсутствия плана; периодические напоминания плана помогают | [68] | B | V |
| 2.4 | Advisor (strong on-demand) поднимает слабого executor'а при меньшей цене | [32] | B (vendor) | V |
| 2.5 | Экстремальная декомпозиция + голосование + red-flag дают безошибочные 1M шагов на дешёвых моделях | [67] | B | V (через субагента) |
| 2.6 | SLM достаточно для большинства агентных вызовов | [29] | **C (position)** | V |
| 2.7 | Каскады/роутеры экономят 2×–50× при сохранении качества на их бенчмарках | [30][31] | B | V |
| 2.8 | Внешний сигнал (тесты) нужен; intrinsic self-correction не работает | [51][52][53] | A/B | V |
| 2.9 | Open-weight ≤80B не имеют измеренного METR horizon; gpt-oss-120b ~45 мин p50 / ~8 мин p80, Kimi K2 Thinking ~58 / ~15 | [57] | A/B | V (через субагента) |
| 2.10 | Vendor vs independent для малых моделей расходятся на 10–30 п.п. | [69][74][77][78] | B | V (через субагента) |
| 3.1 | Multi-agent +90% на research, ×15 токенов, плохо для кодинга | [37] | B (vendor internal) | V |
| 3.2 | Эффект multi-agent от +81% до −70% в зависимости от декомпозируемости | [40] | B | V |
| 3.3 | Топ причин провалов MAS: повторение шагов, reasoning-action mismatch, незнание условий завершения, слабая верификация | [39] | B | V |
| 3.4 | Параллельные писатели без общего контекста конфликтуют | [38] | C | V |
| 4.1 | LLM-judge ≈ человек (>80%), но с position/verbosity/self-enhancement bias | [46] | A | V |
| 4.2 | Agent-as-a-Judge с tools лучше LLM-as-judge на dev-задачах | [47] | B | V |
| 4.3 | Каскад дешёвый judge → эскалация даёт гарантии согласия | [48] | B | V |
| 4.4 | Слабые мониторы могут следить за сильными агентами при правильном scaffold; human только на флагах | [49] | B | V |
| 4.5 | Inference-time PRM с таксономией: +10.6 п.п. SWE-bench Verified, диагноз лучше предписания | [50] | B | V |
| 4.6 | Самоотчёты агентов о прогрессе/бюджете оптимистичны и нестабильны | [54][55] | B | V |
| 4.7 | Классификаторы по траекториям предсказывают исход (до 0.95 AUROC) | [56] | B (свежий preprint) | V |
| 5.1 | Time horizon: логистика по log(human time); p80 ≪ p50; удвоение 4–7 мес | [57] | A/B | V (через субагента) |
| 5.2 | Monte Carlo по историческим velocity — практичный метод прогноза | [70] | C | V |

---

## 7. Q6 — Переиспользуемые open-source реализации

Код читался через shallow clone (без запуска) в
`scratchpad/clones/`; HEAD и даты — на 2026-10-19; лицензии и звёзды — через GitHub API в
тот же день. Ключевые константы перепроверены вручную (Codex, OpenHands SDK, opencode, goose)
[V]; остальное — по отчёту субагента-читателя кода [V, выборочно].

### 7.1 Как устроена compaction/handoff в живых harness'ах

Источники: [83]–[93]; сводное source-code исследование 11 harness'ов (Claude Code, Codex
CLI, Gemini CLI, OpenHands, Aider, mini-SWE-agent, OpenCode и др.) — [82] (preprint
2026-07, abstract: context management — один из 7 канонических подсистем; embeddings для
retrieval не использует ни один runtime) [V abstract; B].

| Проект (HEAD) | Лицензия, ★ | Trigger | Что сохраняется / schema | Что взять |
|---|---|---|---|---|
| **openai/codex** `d70c2c2c` | Apache-2.0, ~130k | `auto_compact_token_limit = min(config, 0.9·window)` (`codex-rs/protocol/src/openai_models.rs:529-540`); async compaction 65% default (`core/src/config/mod.rs`) | Prompt `codex-rs/prompts/templates/compact/prompt.md`: «CONTEXT CHECKPOINT COMPACTION… handoff summary for another LLM»: progress+decisions, constraints/preferences, next steps, critical references; `summary_prefix.md` говорит новой модели строить на этом и не дублировать. Rebuild: initial context + последние **реальные user messages до 20k токенов** + summary (`core/src/compact.rs:64,715-820`). Remote-вариант — opaque encrypted compaction item | «Handoff для другого LLM» framing; verbatim user-сообщения под cap |
| **anomalyco/opencode** (бывш. sst) `b56e2537` | MIT, ~218k | ceiling = window − max(15%·window, 16k) (`packages/core/src/session/compaction.ts:95-105,941-947`); при overflow shrink 0.7/0.5/0.35 | Markdown template: Objective / Requirements / Decisions / Work State (Completed/Active/Blocked) / Next Move / Relevant Files (≤15) / Important Context; rules: сохранять точные пути/идентификаторы/ошибки и git/PR state, не пересказывать AGENTS.md; **отдельный update-prompt для инкрементального checkpoint**; nudge при нарушении шаблона; recent context ~15k verbatim | Лучший готовый шаблон + update prompt. Комментарий в коде: до PR #48058 (2026-09) checkpoints «раздувались» при preserve-first обновлениях — практическое подтверждение дрейфа итеративных summary |
| opencode v1 (тег `v1.19.3`) | MIT | `PRUNE_MINIMUM=20k`, `PRUNE_PROTECT=40k` | Prune старых tool outputs (кроме последних 40k и skill-вызовов) | Observation-pruning как в [16] |
| **Kilo-Org/kilocode** `87cc35ce` | MIT, ~28k | как opencode + opt-in `threshold_percent` | тот же шаблон | — |
| **cline/cline** `41e75efc` | Apache-2.0, ~71k | SDK: input = 0.9·window, trigger 0.9 от usable (≈81%), target 0.7, preserve recent 20k, summary ≤8192 out (`sdk/packages/core/src/extensions/context/compaction-shared.ts:15-37`) | Goal / State (Done/In Progress/Blocked) / Highlights / Next / Files (Read/Edited) — **Files заполняются автоматически из file-операций** | Детерминированный file list (закрывает artifact trail [17]) |
| cline legacy `v3.89.2` | Apache-2.0 | max allowed: 64k→W−27k, 128k→W−30k, 200k→W−40k | `new_task` tool: Current Work / Key Technical Concepts / Relevant Files and Code / Problem Solving / Pending Tasks and Next Steps **с дословными цитатами**; превью пользователю; Focus Chain todo с напоминанием каждые 6 запросов | Handoff-as-tool + periodic plan reminder |
| **OpenHands/software-agent-sdk** `33d8aa29` | MIT, ~1.3k (основной OpenHands ~MIT) | `LLMSummarizingCondenser`: default `max_size=240, keep_first=2`; `default_condenser()` 80/4; trigger по событиям или токенам; агент может запросить сам | Prompt `prompts/summarizing_system.j2`: USER_CONTEXT, TASK_TRACKING (**сохранять task IDs**), COMPLETED, PENDING, CURRENT_STATE, CODE_STATE, TESTS, CHANGES, DEPS, VERSION_CONTROL_STATUS. Condensation хранится как событие в event log (non-destructive) | Schema-ключи; event-sourced condensation (совпадает с Guanxi checkpoint model) |
| OpenHands **StuckDetector** (SDK) | MIT | окно ≤20 событий после последнего user msg | action+observation одинаковы ×4; action+error ×3 (nudge на 3, stuck >3); monologue ×3; A/B чередование ×6; context-window-error loop — заглушка; сравнение игнорирует IDs (`conversation/stuck_detector.py`, `conversation/types.py:136-160`) | Готовые L1-эвристики (§8.2) |
| **aaif-goose/goose** (бывш. block) `fb9e3c89` | Apache-2.0, ~55k | `DEFAULT_COMPACTION_THRESHOLD=0.8`, cap 225k токенов | `<analysis>` + **JSON**: user_intent[], technical_concepts[], files[{path, summary, key_code}], errors_and_fixes[], problem_solving[], user_messages[], pending_tasks[], current_work, next_step (`crates/goose-context-management/src/prompts/compaction.md`, `structured.rs`); при переполнении — middle-out удаление tool responses; оригиналы скрыты от агента, видны пользователю | Типизированная JSON-схема handoff |
| **SWE-agent** `3ea751c0` / **mini-swe-agent** `04d809ce` | MIT | SWE-agent: `LastNObservations(n)` (в статье n=5), elision «Old environment output»; cost limit 3.0/instance; mini: без compaction, `cost_limit`, `step_limit`, `wall_time_limit` | — | Observation masking; лимиты как watchdog |
| **Aider-AI/aider** `5dc9490b` | Apache-2.0, ~50k | `max_chat_history_tokens = clamp(input/16, 1024, 8192)` | Рекурсивный `ChatSummary` (хвост < ½ бюджета дословно, голова суммируется, глубина ≤3, weak model сначала, фоном) | Фоновая суммаризация дешёвой моделью |
| **letta-ai/letta** (archive) / **letta-code** `531489bb` | Apache-2.0 | trigger 0.9; sliding window: цель 70% окна, eviction шагами 10% до границы assistant-сообщения | ≤300 слов: goals, what happened, important details (identifiers verbatim), errors and fixes, lookup hints; memory blocks; sleep-time agents | Memory blocks + sleep-time процессы как модель «фоновой консолидации заметок» |
| RooCodeInc/Roo-Code `b867ec91` | Apache-2.0, **archived** | `autoCondenseContextPercent=100` (по умолчанию фактически 0.9·W − maxTokens) | 9-секционный шаблон с verbatim цитатами; non-destructive (`condenseParent`) | Только как reference (архив) |
| anthropics/claude-code | **проприетарный** («All rights reserved») | per-model auto-compact window (CHANGELOG) | — | **Не заимствовать код** |

### 7.2 Прочие переиспользуемые компоненты

| Компонент | Лицензия / активность | Применимость |
|---|---|---|
| metauto-ai/agent-as-a-judge [47] | MIT, ~0.8k★, push 2026-03 | Идеи judge-агента с tools; DevAI как формат иерархических требований |
| alexzhang13/rlm [23] | MIT, ~5.7k★ | Чтение огромных логов/трейсов слабой моделью через REPL (локальный sandbox) |
| ace-agent/ace [19] | Apache-2.0, ~1.4k★ | Generator/reflector/curator для lessons → playbook/skills (K-лейн) |
| steveyegge/beads [35] | MIT, ~28k★, активен | Модель task graph (`ready`, claim, decay); можно взять схему, хранилище — своё SQLite |
| github/spec-kit [33] | MIT, ~142k★ | Шаблоны spec/plan/tasks для lead-планировщика |
| a2aproject/A2A [58] | Apache-2.0, ~26k★ | State machine задач + push notifications для hibernation/wake |
| SqueezeAILab/LLMCompiler [28] | MIT, неактивен с 2024 | Идея DAG-плана; код устарел |
| lm-sys/RouteLLM [31] | Apache-2.0, неактивен с 2024-08 | Только идея router; код не брать как зависимость |
| eyaltoledano/claude-task-master [36] | **MIT + Commons Clause** (GitHub: NOASSERTION) | Не OSI-open; **не копировать код** в Guanxi; идеи (complexity analysis, expand) — можно |
| multi-agent-systems-failure-taxonomy/MAST [39] | **лицензия не указана** (по умолчанию all rights reserved) | Только таксономия как идея/цитата; код и датасет не брать без лицензии |

**Атрибуция [I]:** Apache-2.0 требует сохранить NOTICE и пометить изменения; MIT — copyright
notice. Prompt-шаблоны — часть кода и тоже под лицензией проекта → в `THIRD_PARTY`/`NOTICE`
(L1).

---

## 8. Рекомендуемые протоколы

Все протоколы ниже — **proposed**. Термины: **Run** — делегированная работа (durable Job);
**Cycle** — одна «жизнь» контекстного окна исполнителя; **Step** — один ход модели с tool
call; **Item** — пункт плана с acceptance.

### 8.1 Relay handoff protocol (C5)

#### 8.1.1 Состояния цикла

```
boot → orient → work ─┬─(item closed & usage ≥ B)──────────────┐
                      ├─(usage ≥ T_soft)→ wind_down ──────────┤
                      └─(usage ≥ T_hard | wind_down done)─────┴→ handoff_write
handoff_write → handoff_validate ─┬─ ok → sealed → boot(next cycle) | finish | escalate
                                  └─ fail ×2 → harness_fallback → sealed
```

- **boot:** новый контекст = system prompt + project instructions + plan excerpt + handoff.
- **orient (обязательно, как в [2]):** `git status`/HEAD-проверка, прогон acceptance текущего
  item'а (или smoke), ответ на probes (§8.1.5). Ловит «сломанное состояние» предыдущего цикла.
- **work:** шаги; внутри цикла — observation masking старых outputs (окно M≈8–10 ходов) [16],
  обрезка длинных tool outputs со ссылкой на evidence-файл, напоминание текущего milestone
  каждые ~6 шагов (как Focus Chain у Cline) [68].
- **wind_down:** запрещено брать новый item; доделать атомарный шаг; прогнать проверки;
  commit (WIP-commit в ветку Run'а допустим); обновить notes.
- **handoff_write / validate / sealed:** §8.1.3–8.1.5. Sealed handoff — immutable Artifact.

#### 8.1.2 Пороги: вычислять из резервов, а не задавать %

Обозначения (все в токенах, источники — runtime/adapter/policy, не UI-константы, что
соответствует инварианту AGENTS.md про отсутствие произвольных ceilings):

- `W` — фактически загруженный `num_ctx` (из runtime, а не запрошенный: Ollama может молча
  урезать/обрезать [65]);
- `R_turn` — максимум вывода на ход (включая thinking);
- `S` — запас на ошибку подсчёта токенов, `max(512, 0.03·W)`;
- `R_tool` — cap на размер следующего tool observation (через обрезку output);
- `R_ho` — бюджет narrative handoff (вывод) + инструкции handoff-промпта;
- `step_med` — медиана токенов на шаг в этом Run (обновляется онлайн);
- `E` — опциональный cap «эффективной длины» модели из калибровки (probe-тест на
  конкретной модели/квантизации; см. §10).

Формулы:
- **Hard ceiling (никогда не превышать):** `H = W − R_turn − S`.
- **T_hard (немедленно handoff_write):** `T_hard = H − R_ho − R_tool`.
- **T_soft (wind_down):** `T_soft = min(0.75·W, T_hard − step_med, E)`.
- **Boundary rule:** если item закрыт (acceptance прошёл) и `usage ≥ B`, где
  `B = max(0.5·W, T_soft − ожидаемые_токены_следующего_item)`, — handoff сразу, на чистой
  границе (Amp «focused threads» [10], Anthropic «одна фича за сессию» [2]).

Примеры (иллюстрация, параметры условные):

| W | R_turn | S | H | R_ho | R_tool | T_hard | step_med | T_soft |
|---|---|---|---|---|---|---|---|---|
| 32,768 | 4,096 | 983 | 27,689 (85%) | 2,500 | 3,000 | 22,189 (**68%**) | 1,500 | 20,689 (**63%**) |
| 65,536 | 4,096 | 1,966 | 59,474 (91%) | 3,000 | 4,000 | 52,474 (**80%**) | 2,000 | 49,152 (**75%**) |
| 131,072 | 8,192 | 3,932 | 118,948 (91%) | 4,000 | 4,000 | 110,948 (85%) | 2,500 | 98,304 (75%) → с `E=64k`: **64k (49%)** |

**Вывод [I]:** «75% старт / 90% финиш» владельца примерно верен для 64k при умеренном
выводе; для 32k он слишком поздний (handoff не поместится), для 128k — может быть слишком
поздним по качеству (context rot), если не задан `E`.

**Базовая нагрузка цикла.** `base = system + tools schema + instructions + plan excerpt +
handoff` должна быть ≤ ~25–30% `W`, иначе на работу не остаётся места: при `W=32k` handoff
(отрендеренный) — цель ≤10–12% `W`, жёсткий максимум 15% `W` [I].

**Подсчёт.** Usage = `prompt_eval_count` последнего ответа + оценка добавленного (tool output,
новое сообщение) токенизатором модели; если ответ показывает `prompt_eval_count` меньше
ожидаемого — это признак усечения, протокольная ошибка, а не «успех» [65] [I].

#### 8.1.3 Кто пишет handoff: три слоя

1. **Ledger (harness-owned, детерминированный, ~всегда актуален):** состояние плана из task
   tracker'а (ID, статус, attempts, evidence refs); git (branch, HEAD, dirty, diffstat с начала
   Run'а); `files_touched` из tool audit; последние запуски проверок (команда, время,
   результат, краткая сводка, ссылка на лог); счётчики ошибок/зацикливаний; время/бюджет/ETA.
   Это закрывает самое слабое место компрессии — artifact trail [17] — и «задача трекается
   чётко».
2. **Notes (agent-written, append-only, типизированные):** tool `note.add(kind, text, refs)`
   с kinds `decision | dead_end | hypothesis | open_issue | lesson`; harness присваивает ID,
   дедуплицирует, закрытое «сворачивает» в одну строку (memory decay как в beads [35]);
   никогда не переписывается целиком (ACE: против context collapse/brevity bias [19]).
3. **Narrative delta (LLM-written при handoff, ≤ `R_ho`):** что делал прямо сейчас,
   следующие 1–3 действия, текущая гипотеза, «осторожно». Только последняя версия, предыдущая
   не суммируется (против «summary of summary» [10]).

**Fresh-context handoff writer (рекомендуемый default для слабых моделей) [I]:** narrative
пишет отдельный вызов той же локальной модели в **чистом контексте**, получающий ledger +
notes + последние K ходов (actions + обрезанные observations, ≤30–40% `W`). Обоснование:
насыщенный контекст — худшая точка качества [3][24], а сырые ошибки в контексте
самообусловливают модель [66]; production-compaction у Codex/Claude/OpenHands тоже отдельный
summarization-вызов, Amp использует вторичную модель [12][10]. Цена — один лишний prefill;
по brief вычисления локально бесплатны. Альтернатива (in-session writer) допустима при
`W ≥ 64k`.

**Fallback:** если narrative дважды не прошёл валидацию или не уложился в `T_hard→H`,
harness собирает handoff из ledger + notes + последних N действий (observation-masked) и
ставит `narrative.status = "degraded"` — прогресс не теряется никогда.

#### 8.1.4 Схема артефакта `guanxi.handoff/v1` (источник истины — JSON; в промпт — Markdown)

```jsonc
{
  "schema": "guanxi.handoff/v1",
  "run_id": "run_…", "cycle": 17, "parent_handoff_id": "ho_…", "created_at": "2026-10-19T03:12:40Z",
  "producer": { "model": "qwen3-coder-30b-a3b-instruct@Q4_K_M", "host": "mac-studio",
                "writer": "fresh_context | in_session | harness_fallback" },
  "objective": {                       // копия из immutable plan rev; executor не меняет
    "goal": "…", "definition_of_done": ["…"], "plan_ref": "plan.json#rev=3",
    "current_milestone": "M2", "constraints": ["не менять публичный API X", "tests/ read-only"]
  },
  "plan_state": {                      // harness-owned (task tracker)
    "items": [{ "id": "T-12", "title": "…", "status": "done|in_progress|todo|blocked|abandoned",
                "acceptance": "npm test -w server -- foo.test.ts", "attempts": 2,
                "evidence_refs": ["ev-881"], "est_human_min": 20, "actual_min": 34 }],
    "next_item": "T-13", "proposed_amendments": [{ "id": "A-1", "text": "…", "status": "pending_lead" }]
  },
  "workspace": {                       // harness-owned (git + tool audit)
    "repo": "…", "worktree": "…", "branch": "run/…", "head": "abc1234", "dirty": false,
    "diffstat_since_run_start": "+412 −88 in 9 files",
    "files_touched": [{ "path": "src/a.ts", "ops": ["edit"], "cycles": [15, 17], "why_note": "D-4" }]
  },
  "verification": {                    // harness-owned (evidence)
    "last_runs": [{ "cmd": "npm test", "at": "…", "result": "fail",
                    "summary": "3 failed: foo>bar …", "log_ref": "ev-900" }],
    "gates": { "typecheck": "pass", "unit": "fail", "e2e": "not_run" }
  },
  "decisions":   [{ "id": "D-4", "text": "…", "reason": "…", "cycle": 12 }],          // notes
  "dead_ends":   [{ "id": "X-2", "tried": "…", "why_failed": "…", "retry_only_if": "…" }],
  "open_issues": [{ "id": "Q-3", "text": "…", "blocking": true, "escalate_to": "advisor|lead|user" }],
  "lessons":     [{ "id": "L-1", "text": "…", "scope": "run|project", "skill_candidate": false }],
  "narrative": {                       // LLM, ≤ R_ho
    "status": "ok|degraded", "in_progress": "…", "next_actions": ["…", "…"],
    "hypothesis": "…", "watch_out": ["…"]
  },
  "context_pointers": {                // just-in-time retrieval [1]
    "must_read": ["docs/x.md#section", "src/a.ts:120-180"], "skills": ["testing"], "instructions": ["AGENTS.md"]
  },
  "health": { "cycle_tokens_peak": 21400, "steps": 54, "stuck_signals": [],
              "judge_last": { "verdict": "on_track", "at": "…" }, "no_progress_cycles": 0 },
  "budget": { "elapsed": "PT3H10M", "deadline": "…",
              "eta": { "p50": "…", "p80": "…", "basis": "ebs+throughput", "confidence": "medium", "observed_at": "…" } },
  "integrity": { "ledger_hash": "sha256:…", "probes": { "passed": 5, "total": 5 } }
}
```

Рендер в промпт: фиксированный порядок секций (Objective → Current item + acceptance →
Next actions → Verification → Dead ends → Decisions → Open issues → Files → Pointers), чтобы
«что делать сейчас» стояло рядом с концом промпта (lost-in-the-middle [4]). Схема — свод
лучших частей Codex/opencode/Cline/OpenHands/goose/Factory/Anthropic harness [2][17][83]–[87].

#### 8.1.5 Валидация (до `sealed`)

1. **Schema** (Zod в `packages/contract`).
2. **Referential integrity:** пути существуют (или помечены удалёнными), item IDs есть в
   tracker, evidence refs существуют, `head` = реальный HEAD.
3. **Size:** рендер ≤ 15% `W`.
4. **Monotonicity:** `done → todo` только с записью decision; подсчёт progress delta.
5. **Probe check** (по мотивам probe-eval Factory [17]) в фазе `orient` следующего цикла:
   harness детерминированно генерирует 3–5 вопросов из ledger («какой item текущий?», «какая
   команда его проверяет?», «какие файлы изменены для T-12?», «каков последний результат
   unit gate?»), сверяет ответы с ledger. Провал критического probe → перерендер handoff с
   акцентом/повтор; второй провал → judge L2.

#### 8.1.6 Анти-деградация между циклами

- Plan/ledger — источник истины; narrative живёт один цикл; notes копятся с curation.
- **Progress invariant:** каждый цикл обязан дать ≥1 из: смена статуса item, новый пройденный
  gate, commit, новая decision/dead_end запись. Иначе `no_progress_cycles++`; 2 → L2 judge;
  3 → эскалация (advisor/lead).
- **Dead-end guard:** перед действием, похожим на `dead_ends[*].tried` (эвристика по
  команде/файлу/хэшу диффа), — предупреждение агенту и флаг judge'у.
- **Commit discipline:** commit на каждом закрытом item и в `wind_down` → новый цикл никогда
  не стартует с неизвестного состояния [2]; edit-checkpoints защищают от перезаписи
  правильного кода [80].
- **Lessons → skills:** `lessons.scope=project` становятся *предложениями* для project
  skill/AGENTS.md (K-лейн), применяются только после review лида [I].
- **Число циклов не ограничено**, ограничение — время (Q-27) и progress invariant.

### 8.2 Judge/monitor для локального overnight-прогона (C6, C7)

| Слой | Что | Когда | Цена | Действие |
|---|---|---|---|---|
| **L0 watchdog** (детерминированно) | heartbeat executor-процесса (30–60 с), stall (нет input/output токенов X мин — Q-27), lease хоста, deadline/`wrap up`, crash/OOM, зависший test runner, место на диске | непрерывно, на main state node | 0 токенов | restart cycle из последнего sealed handoff; `host_lost` после ретраев; wrap-up |
| **L1 heuristics** | OpenHands-паттерны: action+obs ×4, action+error ×3 (nudge) / >3 (stuck), monologue ×3, A/B ×6 [86]; + Guanxi: edit-revert осцилляция, одинаковая сигнатура падения теста N раз, нет диффа K шагов, правки вне scope item'а, **правка тестов при красном acceptance** (подозрение на test tampering), токены на item ≫ оценки (×3), повтор dead-end | каждый шаг | 0 токенов | nudge в виде environment-сообщения; принудительный handoff (свежий контекст лечит self-conditioning [66]); флаг для L2 |
| **L1.5 checker от лида** (опц.) | детерминированный скрипт/классификатор, который сильная модель пишет при планировании (`progress_check`: парсит ledger + JSON тестов → score) | на границе цикла | 0 токенов | вход в L2 |
| **L2 local LLM judge** | свежий контекст; вход: item + acceptance, handoff, дифф с прошлой проверки, gates, L1-флаги; **taxonomy-guided rubric** [50]; выход: `verdict ∈ {on_track, drifting, stuck, plan_problem, done_unverified, done_candidate}`, `taxonomy[]` (redundant_exploration, looping, scope_creep, test_tampering, premature_done, wrong_approach, env_problem), `confidence`, `rationale ≤100 слов`, `hint` (диагноз, **не** предписание действия) | граница цикла + каждые ~30 мин | локальные токены | hint; forced handoff; re-plan request; L3 |
| **L3 strong review** | Agent-as-a-Judge-стиль [47]: сильная модель с tools читает дифф, сама гонит тесты | только pre-flagged [48][49]: L2 low-confidence + флаг; 2 hint'а без эффекта; `plan_problem`; `done_candidate` (финальная приёмка) | дорого (квота) | accept / новый plan rev / stop |

Детали:
- **Confidence L2** — дешёвая self-consistency: 2–3 сэмпла, согласие → уверенность; низкая →
  эскалация (идея cascaded selective evaluation [48]) [I].
- **Bias:** judge не видит самооценок executor'а без evidence; rubric привязан к acceptance;
  требовать ссылки на evidence в rationale; для C7 (ревью той же моделью) — другой system
  prompt, свежий контекст, по возможности другая модель/семейство (self-enhancement [46]);
  ревью без tool feedback не считать доказательством [51].
- **Completion** = все gates item'ов зелёные + evidence + (опц.) L3 приёмка; «агент сказал
  done» — только триггер проверки [2][55].
- **Агент знает о мониторинге** — это снижает надёжность мониторов [49]; не раскрывать
  executor'у детали L1/L2-эвристик в промпте [I].
- **Будущее:** обучить маленький классификатор исхода на собственных трейсах Guanxi
  (per-task дискриминаторы до 0.95 AUROC в [56]) — research item, не MVP.

### 8.3 Delegation policy (C1–C3, C7)

**Роли → модели (пример из brief):** Planner/Lead = Fable через Claude-подписку; Coder =
DeepSeek API или локальный Qwen; Computer-use verifier = агент на ChatGPT-подписке; рутина и
L2 judge = локальный Qwen; Advisor = Planner-модель в режиме on-demand.

**Входы политики** (каждый с provenance/временем/уверенностью — инвариант AGENTS.md):
capability evidence (собственные eval Guanxi по классу задач + внешние бенчмарки с пометкой
vendor/independent), стоимость (деньги API; окна квот подписок; локально — время/энергия),
лимиты (`W`, rate limits, reset квот), ограничения политики («только локальные»),
доступность (хост, загруженная модель, очередь Governor).

**Правило назначения item'а [I]:** выбрать самого дешёвого допустимого исполнителя, у
которого прогноз `p_success(model, item.est_human_min) ≥ θ` (θ≈0.8 для unattended ночи;
`p` — логистическая кривая в стиле METR [57], подогнанная на истории Guanxi, с prior из
внешних бенчмарков). Если таких нет — попросить планировщика раздробить item, иначе поднять
tier. Cascade/routing обоснованы [30][31]; гарантий качества routing без собственного eval нет.

**Лестница эскалации в рантайме:** новый цикл со свежим контекстом → hint от L2 → локальный
reviewer → дешёвая API-модель (если политика позволяет) → Advisor (квота `max_uses` на Run,
ответ: план/коррекция/stop ≤~700 токенов [32]) → wake Lead → пользователь.

**Delegation brief (Lead → Executor), обязательные поля** (по [37] + Anthropic harness [2]):
objective + DoD; immutable plan rev с items/acceptance/оценками; constraints и Run policy
(roots, команды, сеть, protected paths); ресурсы (host, model, `W`, keep_alive); judge config
(rubric, пороги L1, cadence); wake policy; бюджет времени (Q-27: expected duration);
формат отчёта. **Return contract:** wake packet (§8.4).

**Multi-agent правила:** один писатель на worktree; параллелить только независимые items на
разных worktree с resource leases и централизованным merge/verification gate [40]; scouts —
read-only, возвращают ≤2k summary [1][37].

### 8.4 Hibernation / wake protocol (C4, C9)

**Состояния Run** (совместимы с A2A TaskState [58] и MCP Tasks [59]; маппинг в Guanxi Job):
`submitted → working ⇄ input_required → wrapping_up → completed | failed | canceled |
rejected`, плюс `interrupted` (процесс/хост пропал; reconcile как в текущем Chat Job) и
внутренняя метка `cycle_boundary`. `wrapping_up` — durable state (закрывает Q-27a): sealed
handoff = wrap-up отчёт.

**Механика:**
1. Lead формирует Run bundle (plan rev, judge config, wake policy, budget) и отправляет через
   Guanxi API на целевой хост (или в fleet scheduler).
2. Lead-сессия «засыпает»: её контекст сохранён (transcript + собственный compaction/handoff),
   0 токенов. Wake = новый turn той же сессии (или новая сессия, засеянная handoff'ом лида +
   wake packet'ом).
3. Executor-хост шлёт heartbeat на main state node; lease с TTL ≈3× heartbeat. **Watchdog
   живёт на main node, а не на executor'е**: истечение lease → ретраи → `interrupted/host_lost`
   → (если политика) reschedule на другой хост с последнего sealed handoff + commit.
4. **Wake triggers:** terminal (`completed/failed/canceled`), `input_required` (решение,
   которое executor не вправе принять), L3-эскалация, deadline/`wrapping_up` завершён,
   `host_lost` после ретраев, исчерпан бюджет. Несрочные события можно батчить до
   утра (quiet hours) — политика пользователя.
5. **Доставка:** transactional outbox: событие сначала пишется в durable log, потом
   доставляется wake-handler'у **at-least-once** с idempotency key (`run_id + transition
   seq`); handler дедуплицирует. Пользовательская нотификация — отдельно, по ADR-0014
   (at-most-once звук). Внешний push (webhook) — по образцу A2A push notifications [58] [I].
6. **Wake packet (≤ ~2–4k токенов):** outcome; таблица items (статус, evidence refs); gates;
   diffstat; последний narrative; сводка judge (verdicts, эскалации, stuck-события); open
   issues/вопросы к лиду; метрики (длительность, циклы, токены, ETA-точность); ссылки для
   drill-down (trace, логи, коммиты). Полный trace не грузится в контекст лида.
7. **Lead review:** Agent-as-a-Judge-стиль [47] (сам гонит тесты, читает дифф) → accept/merge
   или новый plan rev → resubmit в тот же Run.

**Оговорка [I]:** будить Claude «по подписке» = запускать Claude Code/Agent SDK headless с
subscription-аутентификацией; допустимость автоматизации и лимиты окна квот — вопрос лейна
A (Connections), здесь не проверялся.

### 8.5 ETA estimator (C8)

На каждой границе цикла (и по запросу UI):
1. **Burn-down:** оставшиеся items с оценками планировщика (`est_human_min` — планировщик
   обязан их выдать).
2. **Evidence-Based Scheduling [70]:** velocity `r = actual / estimate` по закрытым items этого
   Run'а (вес высокий) + история пары model×host×repo (prior); Monte Carlo: для каждого
   оставшегося item сэмплировать `r`, суммировать, добавить измеренные накладные (handoff на
   цикл × прогноз числа циклов, judge, время тестов).
3. **Вероятность провала item'а:** `p_success` по логистике METR-стиля [57] → ожидаемые ретраи
   `1/p`; items с низким `p` подсвечиваются как кандидаты на эскалацию.
4. **Throughput-sanity:** нижняя граница = прогноз токенов / decode tok/s + prefill на цикл, из
   `prompt_eval_count/duration`, `eval_count/duration` Ollama [65].
5. **Вывод:** `P50–P80`, вероятность успеть к deadline, basis (n закрытых items, n исторических
   прогонов), confidence, observed_at. Самооценку агента использовать максимум как признак,
   не как ETA [54][55].
6. **Калибровка:** доля Run'ов, завершившихся до P80, должна быть ≈80% (метрика в §10).

### 8.6 Трассировка (D6, J1)

События relay (durable, в существующую модель Job events): `run.started`,
`cycle.started{cycle, W, base_tokens}`, `step{tool, tokens_in/out, prefill/decode ms}`,
`threshold.crossed{soft|hard|boundary}`, `handoff.writing{writer}`,
`handoff.validated{probes, size}`, `handoff.sealed{id}`, `judge.verdict{layer, verdict,
taxonomy, confidence}`, `stuck.detected{pattern}`, `escalation{to}`, `wake.sent/acked`,
`run.terminal`. Экспорт — маппинг на OpenTelemetry GenAI semconv (`invoke_agent`,
`invoke_workflow`, `plan`, `execute_tool`, `chat`; статус Development) [60] с
собственными атрибутами `guanxi.relay.cycle`, `guanxi.handoff.id`; каноническая схема —
своя (semconv ещё нестабилен) [I].

**Стоимость (J2):** на Run ведётся cost ledger по Connection: API-деньги, расход окна квоты
подписки (L3/advisor/wake), локальные GPU-часы и токены; он входит в wake packet, в ETA и во
входы delegation policy (§8.3), чтобы и пользователь, и агенты видели цену эскалаций [I].

---

## 9. Связь с текущим Guanxi

- **ADR-0010** уже требует context reconstruction/compaction, periodic independent review,
  repeated-failure detection, restart/resume и 4–6+ h benchmark — этот отчёт даёт им
  конкретику (§8). Противоречий нет.
- **RUNTIME_LIFECYCLE / P3-M checkpoint** (immutable summary + exact source evidence,
  оригинальная история сохраняется) — правильная основа: handoff = новый versioned Artifact
  type `guanxi.handoff/v1` per cycle; non-destructive история полезна для аудита и K-лейна.
- **Q-27** (только time-based limits, stall detector, `wrap up and report`) ↔ L0 + состояние
  `wrapping_up`; **Q-27a** закрывается предложением §8.4 (proposed, требует ADR).
- **Governor:** перезапуск цикла не требует unload модели (keep_alive); lease — на цикл/шаг;
  fresh-context writer и L2 judge — тоже admission-запросы, их надо учитывать в очереди хоста.
- **Ollama silent truncation** [65] → harness обязан сам считать и соблюдать `H`; это
  совпадает с инвариантом «не выводить runtime status без источника».
- **Contract:** schema handoff/wake packet/judge verdict — в `packages/contract` (Zod).

## 10. Как доказать «качество не деградирует» (exit-gate assertions)

По правилу AGENTS.md п.4 каждое заявленное свойство нужно assertion'ом, который падает.

1. **Relay benchmark:** ~20 задач в реальных репозиториях, требующих ≥5 циклов при `W=32k`.
   Сравнить: (a) этот протокол; (b) naive summary-compaction; (c) только observation masking
   [16]; (d) большой `W` одним циклом, где помещается. Метрики: items/час, финальные gates,
   регрессии (ранее зелёные тесты), повторные чтения файлов на цикл, повтор dead-ends после
   handoff, точность probes по циклам, токены и циклы на item.
2. **Assertions:** (i) наклон «успех item'а vs номер цикла» — 95% CI включает 0 (нет
   деградации), (ii) probe accuracy на критических полях ≥ порога, (iii) 0 повторов dead-end,
   помеченных guard'ом, (iv) 100% согласованность ledger ↔ handoff, (v) ни один запрос не
   превысил `H` (нет усечения по `prompt_eval_count`).
3. **Effective-length калибровка `E`:** на каждой паре model×quant прогнать probe-набор
   (поиск факта/инструкции в длинном агентном транскрипте) на длинах 8k…W; `E` = наибольшая
   длина с accuracy ≥ порога.
4. **Judge eval:** реплей трейсов с синтетически внедрёнными петлями, test tampering,
   premature done → recall/precision L1/L2; частота L3-wake в час.
5. **ETA calibration:** доля Run'ов, закончившихся до P80 ≈ 0.8.
6. Отчётность — с разделением **new / regression envelope** и без выдачи mocked gate за
   live-валидацию.

## 11. Риски и открытые вопросы

**Риски:**
1. Слабая модель плохо следует протоколу (формат tools, schema) → fallback-handoff,
   строгий Zod, nudge как у opencode.
2. **Плохой план хуже никакого** [68] → обязательный review плана сильной моделью перед
   dispatch; executor может поднять `plan_problem`.
3. **Reward hacking ночью** (правка тестов, заглушки) — даже у frontier ≥16% «нелегитимных»
   успехов на длинных задачах METR [79] → protected paths, L1-флаг, L3 приёмка.
4. Silent truncation / расхождение токенизаторов → `S`, сверка `prompt_eval_count`.
5. Шум публичных бенчмарков и разрыв vendor/independent 10–30 п.п. → решения только по
   собственному eval.
6. Prefill-стоимость fresh-context writer'а и L2 judge на Mac при длинных `W` — время, не
   деньги; учитывать в ETA и Governor.
7. Автоматическое «пробуждение» подписочной модели — юридически/технически не проверено.
8. Self-enhancement при C7 [46] и неспособность к intrinsic self-correction [51].
9. Многие ключевые источники 2026 года — preprints/вендорские посты (сила B/C).

**Открытые вопросы владельцу:**
1. Кто пишет acceptance-тесты — планировщик заранее (рекомендация для ночных Run'ов) или
   executor?
2. Может ли executor менять тесты/спеки, и какие paths защищены?
3. Права executor'а на amendments плана: только предлагать (рекомендация) или применять мелкие?
4. Wake policy ночью: какие события будят лида немедленно, какие батчатся до утра; квота
   advisor/L3 на ночь.
5. Default writer: fresh-context (рекомендация) или in-session?
6. L2 judge: та же локальная модель, отдельная маленькая модель, или дешёвый API (DeepSeek)?
7. Lessons → project skills: авто или только после review лида (рекомендация)?
8. Выбор `W` для Run'а (больше окно ↔ медленнее prefill и больше памяти) — делегировать
   Governor'у по калибровке `E`?
9. Нужен ли reschedule Run'а на другой хост при `host_lost` автоматически?

---

## 12. Источники

Все URL открыты **2026-10-19**. Пометка «(субагент)» — число/факт проверен параллельным
research-субагентом по первоисточнику в ту же дату; «(через)» — первоисточник недоступен,
факт взят из указанного вторичного источника.

1. Anthropic — Effective context engineering for AI agents (2025-09-29). https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. Anthropic (J. Young) — Effective harnesses for long-running agents (2025-11-26). https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
3. Hong, Troynikov, Huber (Chroma) — Context Rot (2025-07-14). https://www.trychroma.com/research/context-rot
4. Liu et al. — Lost in the Middle: How Language Models Use Long Contexts (TACL). https://arxiv.org/abs/2307.03172
5. Claude API Docs — Compaction overview. https://platform.claude.com/docs/en/build-with-claude/compaction
6. Claude API Docs — Compaction at a token threshold (`compact-2026-01-12`). https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
7. Claude API Docs — Compaction on demand (`compact-2026-09-04`). https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand
8. Claude Code Docs — Manage costs effectively (auto-compaction, compact instructions). https://code.claude.com/docs/en/costs
9. Anthropic — Managing context on the Claude Developer Platform (2025-09-29). https://claude.com/blog/context-management
10. Amp — Handoff (No More Compaction) (2025-10-23). https://ampcode.com/news/handoff
11. Amp — Handoff, Please (из поиска, не открывался напрямую). https://ampcode.com/news/ask-to-handoff
12. badlogic — Context Compaction Research: Claude Code, Codex CLI, OpenCode, Amp (gist, 2025-12-02; вторичный). https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f
13. C. Smith (OpenHands) — OpenHands Context Condensation for More Efficient AI Agents (2025-04-09). https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents
14. OpenHands PR #6597 — Improve performance of LLM summarizing condenser (2025-02). https://github.com/OpenHands/OpenHands/pull/6597
15. OpenHands team (авторы не проверялись) — The OpenHands Software Agent SDK (arXiv:2511.03690; из поиска). https://arxiv.org/abs/2511.03690
16. Lindenbauer et al. — The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization (DL4C @ NeurIPS 2025). https://arxiv.org/abs/2508.21433 ; https://arxiv.org/html/2508.21433v3
17. Factory Research — Evaluating Context Compression for AI Agents (2025-12-16). https://factory.com/news/evaluating-compression
18. Packer et al. — MemGPT: Towards LLMs as Operating Systems. https://arxiv.org/abs/2310.08560
19. Zhang et al. — Agentic Context Engineering (ACE), ICLR 2026. https://arxiv.org/abs/2510.04618 ; code https://github.com/ace-agent/ace
20. Wu et al. — ReSum: Unlocking Long-Horizon Search Intelligence via Context Summarization. https://arxiv.org/abs/2509.13313
21. Ye et al. — AgentFold: Long-Horizon Web Agents with Proactive Context Management. https://arxiv.org/abs/2510.24699
22. Sun et al. — Scaling Long-Horizon LLM Agent via Context-Folding. https://arxiv.org/abs/2510.11967
23. Zhang, Kraska, Khattab — Recursive Language Models. https://arxiv.org/abs/2512.24601 ; code https://github.com/alexzhang13/rlm
24. Laban et al. — LLMs Get Lost In Multi-Turn Conversation. https://arxiv.org/abs/2505.06120
25. OpenAI — Building more with GPT-5.1-Codex-Max (2025-11-19; 403, (через) [94]). https://openai.com/index/gpt-5-1-codex-max/
26. Erdogan et al. — Plan-and-Act (ICML 2025). https://arxiv.org/abs/2503.09572
27. Xu et al. — ReWOO. https://arxiv.org/abs/2305.18323
28. Kim et al. — An LLM Compiler for Parallel Function Calling (ICML 2024). https://arxiv.org/abs/2312.04511 ; code https://github.com/SqueezeAILab/LLMCompiler
29. Belcak et al. (NVIDIA) — Small Language Models are the Future of Agentic AI (position). https://arxiv.org/abs/2506.02153
30. Chen, Zaharia, Zou — FrugalGPT. https://arxiv.org/abs/2305.05176
31. Ong et al. — RouteLLM. https://arxiv.org/abs/2406.18665 ; code https://github.com/lm-sys/RouteLLM
32. Anthropic — The advisor strategy (2026-04-09). https://claude.com/blog/the-advisor-strategy
33. GitHub spec-kit. https://github.com/github/spec-kit
34. Kiro — Specs. https://kiro.dev/docs/specs/
35. beads. https://github.com/steveyegge/beads
36. Task Master. https://github.com/eyaltoledano/claude-task-master
37. Anthropic — How we built our multi-agent research system (2025-06-13). https://www.anthropic.com/engineering/multi-agent-research-system
38. W. Yan (Cognition) — Don't Build Multi-Agents (2025-06-12). https://cognition.com/blog/dont-build-multi-agents
39. Cemri et al. — Why Do Multi-Agent LLM Systems Fail? (MAST). https://arxiv.org/abs/2503.13657 ; https://arxiv.org/html/2503.13657v3 ; repo https://github.com/multi-agent-systems-failure-taxonomy/MAST
40. Kim et al. — Towards a Science of Scaling Agent Systems. https://arxiv.org/abs/2512.08296
41. Hong et al. — MetaGPT. https://arxiv.org/abs/2308.00352
42. Qian et al. — ChatDev (ACL 2024). https://arxiv.org/abs/2307.07924
43. Wu et al. — AutoGen. https://arxiv.org/abs/2308.08155 ; repo (maintenance/archived) https://github.com/microsoft/autogen
44. OpenAI Agents SDK — Handoffs. https://openai.github.io/openai-agents-python/handoffs/
45. Claude Code Docs — Subagents. https://code.claude.com/docs/en/sub-agents
46. Zheng et al. — Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena (NeurIPS 2023 D&B). https://arxiv.org/abs/2306.05685
47. Zhuge et al. — Agent-as-a-Judge. https://arxiv.org/abs/2410.10934 ; code https://github.com/metauto-ai/agent-as-a-judge
48. Jung, Brahman, Choi — Trust or Escalate. https://arxiv.org/abs/2407.18370
49. Kale et al. — Reliable Weak-to-Strong Monitoring of LLM Agents. https://arxiv.org/abs/2508.19461
50. Gandhi et al. — When Agents go Astray: Course-Correcting SWE Agents with PRMs. https://arxiv.org/abs/2509.02360
51. Huang et al. — Large Language Models Cannot Self-Correct Reasoning Yet (ICLR 2024). https://arxiv.org/abs/2310.01798
52. Shinn et al. — Reflexion (NeurIPS 2023). https://arxiv.org/abs/2303.11366
53. Mathews, Nagappan — Test-Driven Development for Code Generation. https://arxiv.org/abs/2402.13521
54. Lin et al. — BAGEN: Are LLM Agents Budget-Aware? https://arxiv.org/abs/2606.00198
55. Wang et al. — The Unreliable Progress Bar. https://arxiv.org/abs/2609.08589
56. Gill et al. — Divergent Paths: Learning an Outcome-Predictive Representation of LLM Agent Trajectories. https://arxiv.org/abs/2610.19614
57. METR — Kwa et al., Measuring AI Ability to Complete Long Tasks (https://arxiv.org/abs/2503.14499); Time Horizon 1.1 (https://metr.substack.com/p/2026-1-29-time-horizon-1-1); https://metr.org/time-horizons/ ; https://metr.org/assets/benchmark_results_1_0.yaml ; https://metr.org/assets/benchmark_results_1_1.yaml (субагент)
58. A2A Protocol Specification (v1.0.0). https://a2a-protocol.org/latest/specification/ ; https://github.com/a2aproject/A2A
59. MCP Specification 2025-11-25 — Tasks (experimental). https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks ; SEP-2663 Tasks Extension (из поиска) https://tasks.extensions.modelcontextprotocol.io/seps/2663-tasks-extension
60. OpenTelemetry GenAI semantic conventions — agent spans. https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
61. Hsieh et al. — RULER. https://arxiv.org/abs/2404.06654 ; https://github.com/NVIDIA/RULER (субагент)
62. Modarressi et al. — NoLiMa. https://arxiv.org/abs/2502.05167 (субагент)
63. Qwen3-30B-A3B-Instruct-2507 model card (RULER, vendor). https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507 (субагент)
64. Claude Code auto-compact threshold — неофициально: issue #63186. https://github.com/anthropics/claude-code/issues/63186 (из поиска)
65. Ollama API — Chat. https://docs.ollama.com/api/chat ; о молчаливом усечении (сообщество, D): https://particula.tech/blog/ollama-num-ctx-silent-prompt-truncation
66. Sinha et al. — The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs (ICLR 2026). https://arxiv.org/abs/2509.09677
67. Meyerson et al. — Solving a Million-Step LLM Task with Zero Errors (MAKER). https://arxiv.org/html/2511.09030 (субагент)
68. Liu et al. — From Plan to Action: How Well Do Agents Follow the Plan? https://arxiv.org/abs/2604.12147
69. SWE-bench leaderboards (embedded JSON). https://www.swebench.com/ (субагент)
70. J. Spolsky — Evidence Based Scheduling (2007-10-26). https://www.joelonsoftware.com/2007/10/26/evidence-based-scheduling/
71. OpenAI — Why we no longer evaluate SWE-bench Verified (2026-02-23; Wayback). https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ (субагент)
72. OpenAI — Separating signal from noise in coding evaluations (2026-07-08; Wayback). https://openai.com/index/separating-signal-from-noise-coding-evaluations/ (субагент)
73. Scale AI — SWE-bench Pro leaderboard / paper. https://labs.scale.com/leaderboard/swe_bench_pro_public ; https://arxiv.org/abs/2509.16941 (субагент)
74. Terminal-Bench 2.0 leaderboard (Wayback 2026-08-26). https://web.archive.org/web/20260826113700/https://www.tbench.ai/leaderboard/terminal-bench/2.0 (субагент)
75. Qwen3.6 model cards. https://huggingface.co/Qwen/Qwen3.6-27B ; https://huggingface.co/Qwen/Qwen3.6-35B-A3B (субагент)
76. Qwen3-Coder-Next. https://huggingface.co/Qwen/Qwen3-Coder-Next ; https://arxiv.org/html/2603.00729 (субагент)
77. Devstral Small 2 model card. https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512 (субагент)
78. OpenAI — gpt-oss model card. https://arxiv.org/html/2508.10925 (субагент)
79. METR — Frontier Risk Report (2026-05-19). https://metr.org/blog/2026-05-19-frontier-risk-report/ (субагент)
80. Coherence Collapse (2026). https://arxiv.org/abs/2603.24631 (субагент)
81. Vending-Bench (авторы не проверялись). https://arxiv.org/abs/2502.15840 (субагент)
82. Barbaste et al. — Harness Engineering: A Source-Code Study of Eleven Systems (2026-07). https://arxiv.org/abs/2609.00006
83. openai/codex @ d70c2c2c (Apache-2.0): `codex-rs/protocol/src/openai_models.rs`, `codex-rs/prompts/templates/compact/prompt.md`, `codex-rs/core/src/compact.rs`. https://github.com/openai/codex
84. anomalyco/opencode @ b56e2537 (MIT): `packages/core/src/session/compaction.ts`; v1 tag v1.19.3. https://github.com/anomalyco/opencode
85. cline/cline @ 41e75efc (Apache-2.0): `sdk/packages/core/src/extensions/context/compaction-shared.ts`; legacy tag v3.89.2 `new_task`, Focus Chain. https://github.com/cline/cline
86. OpenHands/software-agent-sdk @ 33d8aa29 (MIT): `openhands-sdk/openhands/sdk/context/condenser/`, `…/conversation/stuck_detector.py`, `…/conversation/types.py`. https://github.com/OpenHands/software-agent-sdk ; legacy https://github.com/OpenHands/OpenHands (tag 1.6.0)
87. aaif-goose/goose @ fb9e3c89 (Apache-2.0): `crates/goose-context-management/`. https://github.com/aaif-goose/goose
88. SWE-agent @ 3ea751c0 и mini-swe-agent @ 04d809ce (MIT). https://github.com/SWE-agent/SWE-agent ; https://github.com/SWE-agent/mini-swe-agent
89. Aider-AI/aider @ 5dc9490b (Apache-2.0): `aider/history.py`, `aider/prompts.py`. https://github.com/Aider-AI/aider
90. Letta (Apache-2.0): archive branch @ 56ba9c25; letta-code @ 531489bb. https://github.com/letta-ai/letta ; https://github.com/letta-ai/letta-code
91. RooCodeInc/Roo-Code @ b867ec91 (Apache-2.0, archived). https://github.com/RooCodeInc/Roo-Code
92. Kilo-Org/kilocode @ 87cc35ce (MIT). https://github.com/Kilo-Org/kilocode
93. anthropics/claude-code @ ef7bfdca — LICENSE.md (проприетарный), CHANGELOG.md. https://github.com/anthropics/claude-code
94. S. Willison — Building more with GPT-5.1-Codex-Max (2025-11-19). https://simonwillison.net/2025/Nov/19/gpt-51-codex-max/
