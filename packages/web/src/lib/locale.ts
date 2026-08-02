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
}

export function translate(key: LocaleKey): string {
  const language =
    typeof document === 'undefined' ? 'en' : document.documentElement.lang.toLowerCase()
  return language === 'ru' || language.startsWith('ru-') ? russian[key] : english[key]
}
