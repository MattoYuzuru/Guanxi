import type { UiLocale } from '@guanxi/contract'

type GlossaryCopy = {
  term: string
  definition: string
  example: string
}

export type GlossaryEntry = {
  key: string
  en: GlossaryCopy
  ru: GlossaryCopy
}

export const glossaryEntries: readonly GlossaryEntry[] = [
  {
    key: 'chat',
    en: { term: 'Chat', definition: 'A saved conversation with its own history and context.', example: 'Start a new Chat when a new topic should not mix with the previous conversation.' },
    ru: { term: 'Чат', definition: 'Сохраняемая беседа с собственной историей и контекстом.', example: 'Создайте новый Чат, если новая тема не должна смешиваться с прошлой беседой.' },
  },
  {
    key: 'quick-run',
    en: { term: 'Quick Run', definition: 'A one-off task that does not require an ongoing conversation.', example: 'Transcribe one audio file or extract text from one image.' },
    ru: { term: 'Быстрый запуск', definition: 'Одноразовая задача, для которой не нужна продолжающаяся беседа.', example: 'Расшифруйте один аудиофайл или извлеките текст из одного изображения.' },
  },
  {
    key: 'project',
    en: { term: 'Project', definition: 'A logical container for related Chats, files, Recipes, runs, results and permissions.', example: 'Group the conversations and files for one product without making the Project itself a folder.' },
    ru: { term: 'Проект', definition: 'Логический контейнер для связанных Чатов, файлов, Сценариев, запусков, результатов и разрешений.', example: 'Объедините беседы и файлы одного продукта; сам Проект не обязан быть папкой.' },
  },
  {
    key: 'recipe',
    en: { term: 'Recipe', definition: 'A saved way to perform a repeating task with chosen instructions, model preferences and tools.', example: 'A Dictate prompt Recipe uses an STT model and returns the raw transcript.' },
    ru: { term: 'Сценарий', definition: 'Сохранённый способ выполнить повторяющуюся задачу с выбранными инструкциями, моделью и инструментами.', example: 'Сценарий «Диктовка промпта» использует STT-модель и возвращает исходную расшифровку.' },
  },
  {
    key: 'agent-run',
    en: { term: 'Agent Run', definition: 'Long multi-step agent work with a plan, tools, checkpoints, approvals and verification.', example: 'An agent edits code, runs tests, reviews the result and saves evidence.' },
    ru: { term: 'Запуск агента', definition: 'Длительная многошаговая работа агента с планом, инструментами, checkpoints, approvals и проверками.', example: 'Агент меняет код, запускает тесты, проводит review и сохраняет evidence.' },
  },
  {
    key: 'artifact',
    en: { term: 'Artifact', definition: 'A saved input or output of a Job, such as a report, image, transcript or checkpoint.', example: 'An uploaded document and the generated report are separate Artifacts.' },
    ru: { term: 'Результат', definition: 'Сохранённый input или output Задачи: отчёт, изображение, transcript или checkpoint.', example: 'Загруженный документ и созданный отчёт сохраняются как отдельные Результаты.' },
  },
  {
    key: 'job',
    en: { term: 'Job', definition: 'One executable unit of work with queue, progress, cancellation and a terminal result.', example: 'A Chat keeps the conversation while each model invocation is a separate Job.' },
    ru: { term: 'Задача', definition: 'Одна исполняемая единица работы с очередью, прогрессом, отменой и terminal result.', example: 'Чат хранит беседу, а каждый вызов модели выполняется отдельной Задачей.' },
  },
  {
    key: 'installed-model',
    en: { term: 'Installed model', definition: 'Model data available to local Ollama on disk; it does not necessarily occupy memory.', example: 'An installed model can remain on disk while no model is loaded.' },
    ru: { term: 'Установленная модель', definition: 'Данные модели, доступные локальному Ollama на диске; они не обязательно занимают память.', example: 'Модель может быть установлена на диске, когда ни одна модель не загружена.' },
  },
  {
    key: 'loaded-model',
    en: { term: 'Loaded model', definition: 'A runtime instance currently in RAM or VRAM and able to serve work.', example: 'Opening a Chat does not prove its selected model is loaded.' },
    ru: { term: 'Загруженная модель', definition: 'Runtime instance, который сейчас находится в RAM или VRAM и может выполнять работу.', example: 'Открытый Чат сам по себе не доказывает, что выбранная модель загружена.' },
  },
  {
    key: 'model-weights',
    en: { term: 'Model weights', definition: 'The trained parameters stored with a model; ordinary Chats do not rewrite them.', example: 'Unloading a model from memory does not erase or retrain its weights.' },
    ru: { term: 'Веса модели', definition: 'Обученные параметры модели; обычные Чаты их не переписывают.', example: 'Выгрузка модели из памяти не стирает и не переобучает её веса.' },
  },
  {
    key: 'context-window',
    en: { term: 'Context window', definition: 'The limited text and media tokens supplied to one model invocation.', example: 'A long Chat can exceed the window, so only a selected or compacted part is sent.' },
    ru: { term: 'Окно контекста', definition: 'Ограниченный объём text и media tokens для одного вызова модели.', example: 'Длинный Чат может быть больше окна, поэтому отправляется выбранная или скомпакченная часть.' },
  },
  {
    key: 'chat-history',
    en: { term: 'Chat history', definition: 'Messages and results saved on disk; they do not occupy accelerator memory until selected for a call.', example: 'Deleting history can save disk space but does not itself free VRAM.' },
    ru: { term: 'История Чата', definition: 'Сообщения и Результаты на диске; они не занимают память ускорителя, пока не выбраны для вызова.', example: 'Удаление истории экономит диск, но само по себе не освобождает VRAM.' },
  },
  {
    key: 'kv-cache',
    en: { term: 'KV cache', definition: 'A temporary runtime representation of already processed context.', example: 'It can speed up continuation but is usually lost after unload or restart.' },
    ru: { term: 'Кэш контекста', definition: 'Временное runtime-представление уже обработанного контекста.', example: 'Оно ускоряет продолжение, но обычно теряется после unload или restart.' },
  },
  {
    key: 'reasoning',
    en: { term: 'Thinking / Reasoning', definition: 'A separate stream returned by a capable model in addition to its final answer.', example: 'If the provider does not return a separate channel, the UI does not claim hidden reasoning exists.' },
    ru: { term: 'Рассуждение', definition: 'Отдельный поток thinking-capable модели помимо финального ответа.', example: 'Если provider не вернул отдельный channel, UI не изображает скрытое рассуждение.' },
  },
  {
    key: 'retention',
    en: { term: 'Retention', definition: 'The policy that decides how long saved work remains available.', example: 'Choose Keep, 7 days or Session when creating a Chat.' },
    ru: { term: 'Хранение', definition: 'Policy, которая определяет, как долго сохранённая работа остаётся доступной.', example: 'При создании Чата выберите «Хранить», «7 дней» или «На сессию».' },
  },
  {
    key: 'skill',
    en: { term: 'Skill', definition: 'Rules and a workflow an agent can load; a Skill does not grant permissions by itself.', example: 'A coding Skill can explain review steps but cannot silently enable shell access.' },
    ru: { term: 'Инструкция (Skill)', definition: 'Правила и workflow для агента; Skill сам по себе не выдаёт разрешения.', example: 'Coding Skill объясняет review, но не может молча включить доступ к shell.' },
  },
  {
    key: 'mcp-connection',
    en: { term: 'MCP connection', definition: 'A configured local or external source of tools and resources, disabled by default.', example: 'A Project can enable one connection with a visible policy for a particular Run.' },
    ru: { term: 'MCP-подключение', definition: 'Настроенный локальный или внешний источник tools/resources, выключенный по умолчанию.', example: 'Проект может включить одно подключение с видимой policy для конкретного запуска.' },
  },
  {
    key: 'session',
    en: { term: 'Session', definition: 'The lossless, append-only event container for one conversation: every prompt, event and result that the retention policy keeps stays in one log with one writer Node. A Session contains Runs; it is not a Run and not a Chat.', example: 'A Run can retry as a new Attempt while the Session still keeps every first-Attempt event that the retention policy retains.' },
    ru: { term: 'Сессия', definition: 'Контейнер с полной, только дописываемой историей событий одной беседы: каждый запрос, событие и результат, которые сохраняет политика хранения, остаются в одном журнале с одним узлом-писателем. Сессия содержит запуски и сама не является ни запуском, ни чатом.', example: 'Запуск может повториться новой попыткой, но сессия по-прежнему хранит все события первой попытки, которые сохраняет политика хранения.' },
  },
  {
    key: 'run',
    en: { term: 'Run', definition: 'A durable unit of task work with one execution fence, an owning Node and a terminal state. Retries create new Attempts, and a Run can delegate work or wait for child Runs; it is not one model call.', example: 'A Run that waits for a child Run keeps its state while no process is executing.' },
    ru: { term: 'Запуск', definition: 'Долговечная единица работы с одним fencing-токеном, узлом-владельцем и терминальным состоянием. Повторы создают новые попытки; запуск может делегировать работу или ждать дочерние запуски и не равен одному вызову модели.', example: 'Запуск, ожидающий дочерний запуск, сохраняет состояние, пока ни один процесс не выполняется.' },
  },
  {
    key: 'attempt',
    en: { term: 'Attempt', definition: 'One execution segment of a Run on one Node, valid only under a current Lease and fencing token. A retry starts a new Attempt, and two Attempts of one Run never execute at the same time.', example: 'After an executor is lost, the Run continues in a new Attempt only once the old Lease has expired or been released.' },
    ru: { term: 'Попытка', definition: 'Один отрезок исполнения запуска на одном узле, действительный только при действующей аренде и fencing-токене. Повтор начинает новую попытку, и две попытки одного запуска никогда не выполняются одновременно.', example: 'После потери исполнителя запуск продолжается новой попыткой только после истечения или освобождения старой аренды.' },
  },
  {
    key: 'node',
    en: { term: 'Node', definition: 'One machine running the Guanxi service. A Node owns the resources and Leases on that machine; it is not a Connection and not a model.', example: 'The same Session can be open on one Node while its Run executes on another.' },
    ru: { term: 'Узел', definition: 'Одна машина, на которой работает служба Guanxi. Узел владеет ресурсами и арендами этой машины; это не подключение и не модель.', example: 'Одна и та же сессия может быть открыта на одном узле, пока её запуск выполняется на другом.' },
  },
  {
    key: 'connection',
    en: { term: 'Connection', definition: 'A configured way to reach a model or service: a local runtime, an API key, a subscription agent or a search or STT service. A Connection belongs to an account and holds secret references, not secret values.', example: 'Two Connections to the same model can have different limits and different owners.' },
    ru: { term: 'Подключение', definition: 'Настроенный способ обратиться к модели или сервису: локальный runtime, API-ключ, агент по подписке или служба поиска либо STT. Подключение принадлежит аккаунту и хранит ссылки на секреты, а не сами секреты.', example: 'У двух подключений к одной модели могут быть разные лимиты и разные владельцы.' },
  },
  {
    key: 'workspace',
    en: { term: 'Workspace', definition: 'The working surface for one Session: its zones, Blocks, composer and Layout. A Workspace is a view of that Session, not a Project, and it does not require a filesystem folder.', example: 'Moving a Block changes the Workspace Layout, not the Project or the Session log.' },
    ru: { term: 'Рабочее пространство', definition: 'Рабочая поверхность одной сессии: её зоны, блоки, поле ввода и раскладка. Рабочее пространство — представление этой сессии, а не проект, и оно не требует папки на диске.', example: 'Перемещение блока меняет раскладку рабочего пространства, а не проект или журнал сессии.' },
  },
  {
    key: 'block',
    en: { term: 'Block', definition: 'A self-contained pane or card in a Workspace, built in or contributed by a plugin. A Block declares the modes it belongs to and can move between zones without changing the Project.', example: 'Context, Changes and Terminal can be separate Blocks in one Workspace.' },
    ru: { term: 'Блок', definition: 'Самостоятельная панель или карточка рабочего пространства, встроенная или добавленная плагином. Блок указывает, в каких режимах он доступен, и может перемещаться между зонами, не меняя проект.', example: 'Контекст, изменения и терминал могут быть отдельными блоками одного рабочего пространства.' },
  },
  {
    key: 'developer-mode',
    en: { term: 'Developer mode', definition: 'An experience mode for code-oriented work: files, diffs, terminal, processes and the trace are at hand. It keeps its own Layout, so switching to Visual mode does not delete it.', example: 'Use Developer mode to inspect a failing test in the terminal and follow it in the trace.' },
    ru: { term: 'Режим разработчика', definition: 'Режим работы с кодом: файлы, диффы, терминал, процессы и трассировка под рукой. У него собственная раскладка, поэтому переключение в визуальный режим её не удаляет.', example: 'В режиме разработчика разберите упавший тест в терминале и проследите его в трассировке.' },
  },
  {
    key: 'visual-mode',
    en: { term: 'Visual mode', definition: 'An experience mode for artifacts and the product: artifacts, diagrams, product preview and the browser are at hand. It is not a model-autonomy mode: it does not grant the model extra freedom, permissions or decisions.', example: 'Use Visual mode to review the generated interface, then choose Show in Developer to inspect the code.' },
    ru: { term: 'Визуальный режим', definition: 'Режим работы с артефактами и продуктом: артефакты, схемы, предпросмотр продукта и браузер под рукой. Это не режим автономии модели: он не даёт модели дополнительной свободы, прав или решений.', example: 'В визуальном режиме посмотрите собранный интерфейс, затем откройте «Показать в режиме разработчика», чтобы перейти к коду.' },
  },
  {
    key: 'layout',
    en: { term: 'Layout', definition: 'A saved arrangement of a Workspace: zones, Blocks, density and narrow-screen priority for one mode. A Layout resolves from the most specific scope to the built-in one, and window geometry stays on the device.', example: 'Visual mode can keep a compact Layout without changing the Developer mode Layout.' },
    ru: { term: 'Раскладка', definition: 'Сохранённое расположение рабочего пространства: зоны, блоки, плотность и приоритет для узких экранов в одном режиме. Раскладка разрешается от самого конкретного уровня к встроенной, а геометрия окон остаётся на устройстве.', example: 'Визуальный режим может хранить компактную раскладку, не меняя раскладку режима разработчика.' },
  },
  {
    key: 'side-chat',
    en: { term: 'Side chat', definition: 'A side conversation that reads a Session without writing to it. A Side chat is ephemeral by default and labelled as such; the user explicitly chooses Save to session log or Send to main.', example: 'Ask a quick question in a Side chat, then save it to the session log or send the answer to the main conversation.' },
    ru: { term: 'Боковой чат', definition: 'Отдельная беседа, которая читает сессию, но не пишет в неё. По умолчанию боковой чат временный, и это явно указано; пользователь сам выбирает «Сохранить в журнал сессии» или «Отправить в основной чат».', example: 'Задайте быстрый вопрос в боковом чате, затем сохраните его в журнал сессии или отправьте ответ в основной чат.' },
  },
  {
    key: 'lease',
    en: { term: 'Lease', definition: 'A time-bounded grant of ownership for a resource, issued by the Node that owns it. Ownership changes only by a transaction on the granting Node: grant, release, expiry, fenced handover or audited admin break. A timeout stops renewal; it never creates a second holder.', example: 'When an executor stops renewing, the old Lease must expire before a new Attempt can hold the resource.' },
    ru: { term: 'Lease', definition: 'Ограниченное по времени право владения ресурсом, которое выдаёт узел-владелец. Владение меняется только транзакцией на выдавшем узле: выдача, освобождение, истечение, передача с fencing или аудируемый административный разрыв. Таймаут прекращает продление и никогда не создаёт второго владельца.', example: 'Если исполнитель перестал продлевать аренду, старая аренда должна истечь, прежде чем новая попытка получит ресурс.' },
  },
] as const

export function searchGlossary(
  entries: readonly GlossaryEntry[],
  query: string,
  locale: UiLocale,
  limit = 50,
): readonly GlossaryEntry[] {
  const boundedLimit = Math.max(0, Math.min(50, Math.trunc(limit)))
  const normalized = query.trim().toLocaleLowerCase(locale)
  if (!normalized) return entries.slice(0, boundedLimit)
  return entries.filter((entry) => {
    const copy = entry[locale]
    return [copy.term, copy.definition, copy.example]
      .some((value) => value.toLocaleLowerCase(locale).includes(normalized))
  }).slice(0, boundedLimit)
}
