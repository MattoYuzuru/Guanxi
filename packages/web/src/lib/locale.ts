const english = {
  'error.root.title': 'The application could not be displayed',
  'error.root.summary':
    'A client error was contained before it could leave an unexplained blank screen.',
  'error.chat.title': 'Chat could not be displayed',
  'error.chat.summary':
    'The rest of the application is still available. You can leave Chat safely or reload it.',
  'error.reload': 'Reload',
  'error.home': 'Go to Models',
  'error.chats': 'Go to Chats',
  'error.diagnostics': 'Diagnostic details',
  'error.correlation': 'Correlation ID',
  'error.time': 'Observed at',
  'error.route': 'Route',
  'error.type': 'Error',
  'error.componentStack': 'Component stack',
  'error.unknown': 'Unknown client error',
  'error.notAvailable': 'Not available',
  'chat.turn.status.pending': 'Pending',
  'chat.turn.status.completed': 'Completed',
  'chat.turn.status.failed': 'Failed',
  'chat.turn.status.cancelled': 'Cancelled',
  'chat.turn.status.legacy': 'Outcome unknown',
  'chat.turn.status.livePartial': 'Partial output not reconciled',
  'chat.turn.pending.title': 'The response is still pending',
  'chat.turn.pending.summary':
    'No terminal outcome was persisted. The previous connection may have ended before finalization.',
  'chat.turn.failed.title': 'Generation failed',
  'chat.turn.cancelled.title': 'Generation was cancelled',
  'chat.turn.legacy.title': 'This legacy response has no confirmed outcome',
  'chat.turn.legacy.summary':
    'It predates terminal-state tracking and is not treated as a successful response.',
  'chat.turn.completedEmpty.title': 'Completed without visible content',
  'chat.turn.completedEmpty.summary':
    'The provider sent a terminal chunk, but the response contained no visible content.',
  'chat.turn.reason': 'Stop reason',
  'chat.turn.streamMissingTerminal':
    'The response stream ended without a terminal event. Reloaded history is the source of truth.',
  'chat.turn.livePartial.noContent': 'No response text was retained.',
  'chat.turn.error.ollama_unavailable': 'Ollama was unavailable before the response completed.',
  'chat.turn.error.ollama_connect_timeout':
    'Ollama did not accept the connection before the deadline.',
  'chat.turn.error.ollama_load_timeout':
    'Ollama did not produce initial model progress before the load deadline.',
  'chat.turn.error.ollama_stream_idle_timeout':
    'Ollama stopped producing stream progress before the idle deadline.',
  'chat.turn.error.upstream_error': 'Ollama ended the response with an error.',
  'chat.turn.error.runtime_protocol':
    'Ollama ended the stream without the required terminal chunk.',
  'chat.turn.error.storage_error': 'The final response state could not be saved.',
  'chat.turn.error.internal_error': 'The response could not be finalized.',
  'chat.turn.reason.stop': 'provider stop',
  'chat.turn.reason.length': 'output length',
  'chat.turn.reason.tool_calls': 'tool call step',
  'chat.turn.reason.tool_limit': 'tool step limit',
  'chat.turn.reason.stopped_by_user': 'explicit stop',
  'chat.turn.reason.connection_aborted': 'connection closed',
  'chat.turn.reason.provider_error': 'provider error',
  'chat.turn.reason.protocol_error': 'provider protocol failure',
  'chat.turn.reason.storage_error': 'storage failure',
  'chat.turn.reason.internal_error': 'internal failure',
  'chat.turn.reason.legacy_terminal_chunk': 'legacy terminal chunk',
  'chat.turn.reason.error': 'error',
  'health.ollama.unavailable.title': 'Ollama is unavailable',
  'health.ollama.unavailable.summary':
    'History and settings remain available. New runtime operations are disabled.',
  'health.ollama.incompatible.title': 'Ollama returned an incompatible response',
  'health.ollama.incompatible.summary':
    'The runtime answered, but its version response did not match the supported protocol.',
  'health.retry': 'Check again',
  'health.observedAt': 'Observed at',
  'health.source': 'Source',
  'runtime.title': 'Loaded models',
  'runtime.checking': 'Checking the current /api/ps sample…',
  'runtime.error.title': 'Running models are unavailable',
  'runtime.error.summary':
    'No loaded-model state is inferred while the Ollama sample is unavailable.',
  'runtime.retry': 'Retry runtime check',
  'runtime.empty.title': 'No loaded models were observed',
  'runtime.empty.summary':
    'This is one sampled /api/ps observation; it does not prove what happened between samples.',
  'runtime.sampled': 'Sampled from Ollama /api/ps',
  'runtime.size': 'Runtime size',
  'runtime.acceleratorSize': 'Accelerator bytes',
  'runtime.context': 'Context',
  'runtime.expiry': 'Expires',
  'runtime.unknown': 'Unknown',
  'catalog.source.fresh.title': 'Fresh remote catalog',
  'catalog.source.fresh.summary': 'The displayed provider sample is current.',
  'catalog.source.stale.title': 'Stale local catalog cache',
  'catalog.source.stale.summary':
    'Cached recommendations may be out of date; bundled entries can supplement them.',
  'catalog.source.bundled.title': 'Bundled catalog fallback',
  'catalog.source.bundled.summary':
    'No allowed live provider was queried. This dated bundled snapshot may be out of date.',
  'catalog.source.unavailable.title': 'Catalog source unavailable',
  'catalog.source.unavailable.summary':
    'No allowed catalog source returned data. Installed models remain separate.',
  'catalog.source.unknown.title': 'Catalog freshness is unknown',
  'catalog.source.unknown.summary': 'No source observation is available yet.',
  'catalog.source.observedAt': 'Checked',
  'catalog.source.fetchedAt': 'Source timestamp',
} as const

type LocaleKey = keyof typeof english
type Messages = Record<LocaleKey, string>

const russian: Messages = {
  'error.root.title': 'Не удалось показать приложение',
  'error.root.summary':
    'Ошибка интерфейса остановлена до того, как экран стал необъяснимо пустым.',
  'error.chat.title': 'Не удалось показать чат',
  'error.chat.summary':
    'Остальная часть приложения доступна. Можно безопасно уйти из чата или перезагрузить его.',
  'error.reload': 'Перезагрузить',
  'error.home': 'К моделям',
  'error.chats': 'К чатам',
  'error.diagnostics': 'Диагностические сведения',
  'error.correlation': 'Correlation ID',
  'error.time': 'Время наблюдения',
  'error.route': 'Маршрут',
  'error.type': 'Ошибка',
  'error.componentStack': 'Стек компонентов',
  'error.unknown': 'Неизвестная ошибка интерфейса',
  'error.notAvailable': 'Нет данных',
  'chat.turn.status.pending': 'ожидает итога',
  'chat.turn.status.completed': 'завершён',
  'chat.turn.status.failed': 'ошибка',
  'chat.turn.status.cancelled': 'отменён',
  'chat.turn.status.legacy': 'итог неизвестен',
  'chat.turn.status.livePartial': 'partial output не подтверждён',
  'chat.turn.pending.title': 'Ответ всё ещё ожидает итогового состояния',
  'chat.turn.pending.summary':
    'Terminal outcome не был сохранён. Предыдущее соединение могло завершиться до финализации.',
  'chat.turn.failed.title': 'Генерация завершилась ошибкой',
  'chat.turn.cancelled.title': 'Генерация отменена',
  'chat.turn.legacy.title': 'У старого ответа нет подтверждённого итога',
  'chat.turn.legacy.summary':
    'Он создан до учёта terminal state и не считается подтверждённо успешным.',
  'chat.turn.completedEmpty.title': 'Завершено без видимого содержимого',
  'chat.turn.completedEmpty.summary':
    'Provider прислал terminal chunk, но ответ не содержал видимого текста.',
  'chat.turn.reason': 'Причина остановки',
  'chat.turn.streamMissingTerminal':
    'Поток ответа завершился без terminal event. Источником истины остаётся перечитанная история.',
  'chat.turn.livePartial.noContent': 'Текст ответа не был сохранён в live buffer.',
  'chat.turn.error.ollama_unavailable': 'Ollama была недоступна до завершения ответа.',
  'chat.turn.error.ollama_connect_timeout':
    'Ollama не приняла соединение до истечения connect deadline.',
  'chat.turn.error.ollama_load_timeout':
    'Ollama не показала первый progress модели до истечения load deadline.',
  'chat.turn.error.ollama_stream_idle_timeout':
    'Ollama перестала отдавать progress до истечения stream idle deadline.',
  'chat.turn.error.upstream_error': 'Ollama завершила ответ ошибкой.',
  'chat.turn.error.runtime_protocol':
    'Ollama завершила поток без обязательного terminal chunk.',
  'chat.turn.error.storage_error': 'Не удалось сохранить итоговое состояние ответа.',
  'chat.turn.error.internal_error': 'Не удалось финализировать ответ.',
  'chat.turn.reason.stop': 'остановка provider',
  'chat.turn.reason.length': 'лимит длины ответа',
  'chat.turn.reason.tool_calls': 'шаг вызова инструмента',
  'chat.turn.reason.tool_limit': 'лимит шагов инструмента',
  'chat.turn.reason.stopped_by_user': 'явная остановка',
  'chat.turn.reason.connection_aborted': 'соединение закрыто',
  'chat.turn.reason.provider_error': 'ошибка provider',
  'chat.turn.reason.protocol_error': 'ошибка протокола provider',
  'chat.turn.reason.storage_error': 'ошибка хранилища',
  'chat.turn.reason.internal_error': 'внутренняя ошибка',
  'chat.turn.reason.legacy_terminal_chunk': 'старый terminal chunk',
  'chat.turn.reason.error': 'ошибка',
  'health.ollama.unavailable.title': 'Ollama недоступна',
  'health.ollama.unavailable.summary':
    'История и настройки остаются доступны. Новые runtime-операции выключены.',
  'health.ollama.incompatible.title': 'Ollama вернула несовместимый ответ',
  'health.ollama.incompatible.summary':
    'Runtime ответил, но version response не соответствует поддерживаемому протоколу.',
  'health.retry': 'Проверить снова',
  'health.observedAt': 'Время наблюдения',
  'health.source': 'Источник',
  'runtime.title': 'Загруженные модели',
  'runtime.checking': 'Проверяем текущий sample /api/ps…',
  'runtime.error.title': 'Состояние загруженных моделей недоступно',
  'runtime.error.summary':
    'Пока sample Ollama недоступен, состояние загруженных моделей не предполагается.',
  'runtime.retry': 'Повторить runtime-проверку',
  'runtime.empty.title': 'Загруженные модели не наблюдались',
  'runtime.empty.summary':
    'Это один sample /api/ps; он не доказывает, что происходило между наблюдениями.',
  'runtime.sampled': 'Sample из Ollama /api/ps',
  'runtime.size': 'Размер runtime',
  'runtime.acceleratorSize': 'Байты на ускорителе',
  'runtime.context': 'Контекст',
  'runtime.expiry': 'Истекает',
  'runtime.unknown': 'Неизвестно',
  'catalog.source.fresh.title': 'Свежий удалённый каталог',
  'catalog.source.fresh.summary': 'Показанный provider sample актуален.',
  'catalog.source.stale.title': 'Устаревший локальный cache каталога',
  'catalog.source.stale.summary':
    'Рекомендации из cache могут отставать; встроенные записи дополняют их.',
  'catalog.source.bundled.title': 'Встроенный fallback каталога',
  'catalog.source.bundled.summary':
    'Разрешённый live provider не запрашивался. Датированный snapshot может отставать.',
  'catalog.source.unavailable.title': 'Источник каталога недоступен',
  'catalog.source.unavailable.summary':
    'Ни один разрешённый источник не вернул данные. Установленные модели остаются отдельными.',
  'catalog.source.unknown.title': 'Свежесть каталога неизвестна',
  'catalog.source.unknown.summary': 'Наблюдения источника пока нет.',
  'catalog.source.observedAt': 'Проверено',
  'catalog.source.fetchedAt': 'Время источника',
}

export function translate(key: LocaleKey): string {
  const language =
    typeof document === 'undefined' ? 'en' : document.documentElement.lang.toLowerCase()
  return language === 'ru' || language.startsWith('ru-') ? russian[key] : english[key]
}
