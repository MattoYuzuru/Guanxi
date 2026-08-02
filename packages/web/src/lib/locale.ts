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
}

export function translate(key: LocaleKey): string {
  const language =
    typeof document === 'undefined' ? 'en' : document.documentElement.lang.toLowerCase()
  return language === 'ru' || language.startsWith('ru-') ? russian[key] : english[key]
}
