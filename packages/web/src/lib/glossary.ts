import type { UiLocale } from '@alamo/contract'

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
