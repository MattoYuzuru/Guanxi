/**
 * The shell's own strings. English is the source and fallback; Russian is curated. The web UI's
 * catalogue is not reachable here (the window may show an error instead of the UI), so the shell keeps a
 * small catalogue of its own. Product name comes from the brand module and is passed as `{product}`.
 */
export type ShellLocale = 'en' | 'ru'

const english = {
  'status.starting.title': 'Starting {product}',
  'status.starting.body': 'Starting the background service on port {port}.',
  'status.checking.title': 'Connecting to {product}',
  'status.checking.body': 'Looking for the background service on port {port}.',
  'status.service_missing.title': 'The {product} service is missing',
  'status.service_missing.body': 'The app could not start its background service. Reinstall {product}. Expected at: {entry}',
  'status.service_missing.detail': 'System message: {detail}',
  'status.port_busy.title': 'Port {port} is in use',
  'status.port_busy.body': 'Another program answers on 127.0.0.1:{port} and it is not {product}. Close that program, or set GUANXI_API_PORT to a free port and open {product} again.',
  'status.health_timeout.started.title': 'The {product} service did not become ready',
  'status.health_timeout.started.body': 'The service was started but did not answer on port {port} within {seconds} seconds. It was stopped. Details are in the service log.',
  'status.health_timeout.attached.title': 'Port {port} does not answer',
  'status.health_timeout.attached.body': 'A program holds 127.0.0.1:{port} but does not answer within {seconds} seconds. {product} did not touch it.',
  'status.service_exited.title': 'The {product} service stopped',
  'status.service_exited.body': 'The service ended while starting (exit code {code}). Log: {log}',
  'status.ui_missing.title': 'The {product} service has no interface',
  'status.ui_missing.body': 'The service on port {port} is running but was started without the interface files. Reinstall {product}.',
  'status.config_invalid.title': 'A setting is not valid',
  'status.config_invalid.body': '{variable} has the value "{value}". Use a number from 1 to 65535 for ports and milliseconds for timeouts, then open {product} again.',
  'status.stopped.title': 'The background service is stopped',
  'status.stopped.body': 'To start it again, choose Reconnect in the View menu.',
  'status.footer': '{product} keeps checking automatically. To start the service again, choose Reconnect in the View menu.',
  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.reconnect': 'Reconnect',
  'menu.stopService': 'Stop background service…',
  'menu.about': 'About {product}',
  'menu.hide': 'Hide {product}',
  'menu.quit': 'Quit {product}',
  'stop.confirm.title': 'Stop the background service?',
  'stop.confirm.detail': 'Running agents and downloads stop with it. Closing this window or quitting {product} never does that.',
  'stop.confirm.stop': 'Stop service',
  'stop.confirm.cancel': 'Cancel',
  'stop.done': 'The background service was stopped.',
  'stop.not_managed': 'This service was not started by {product}, so it is not stopped from here.',
  'stop.not_running': 'The background service is not running.',
  'stop.not_stopped': 'The service (process {pid}) did not stop in time.',
} as const

export type MessageKey = keyof typeof english

const russian: Record<MessageKey, string> = {
  'status.starting.title': 'Запуск {product}',
  'status.starting.body': 'Запускаю фоновую службу на порту {port}.',
  'status.checking.title': 'Подключение к {product}',
  'status.checking.body': 'Ищу фоновую службу на порту {port}.',
  'status.service_missing.title': 'Служба {product} не найдена',
  'status.service_missing.body': 'Приложение не смогло запустить фоновую службу. Переустановите {product}. Ожидалась по пути: {entry}',
  'status.service_missing.detail': 'Сообщение системы: {detail}',
  'status.port_busy.title': 'Порт {port} занят',
  'status.port_busy.body': 'На 127.0.0.1:{port} отвечает другая программа, и это не {product}. Закройте её или задайте GUANXI_API_PORT со свободным портом и откройте {product} снова.',
  'status.health_timeout.started.title': 'Служба {product} не стала готовой',
  'status.health_timeout.started.body': 'Служба запущена, но за {seconds} с не ответила на порту {port}. Её остановили. Подробности в журнале службы.',
  'status.health_timeout.attached.title': 'Порт {port} не отвечает',
  'status.health_timeout.attached.body': 'Какая-то программа занимает 127.0.0.1:{port}, но не отвечает за {seconds} с. {product} её не трогал.',
  'status.service_exited.title': 'Служба {product} остановилась',
  'status.service_exited.body': 'Служба завершилась при запуске (код выхода {code}). Журнал: {log}',
  'status.ui_missing.title': 'У службы {product} нет интерфейса',
  'status.ui_missing.body': 'Служба на порту {port} работает, но запущена без файлов интерфейса. Переустановите {product}.',
  'status.config_invalid.title': 'Недопустимая настройка',
  'status.config_invalid.body': 'У {variable} значение «{value}». Для портов нужно число от 1 до 65535, для таймаутов — миллисекунды. Исправьте и откройте {product} снова.',
  'status.stopped.title': 'Фоновая служба остановлена',
  'status.stopped.body': 'Чтобы запустить её снова, выберите «Переподключить» в меню «Вид».',
  'status.footer': '{product} проверяет подключение автоматически. Чтобы запустить службу заново, выберите «Переподключить» в меню «Вид».',
  'menu.view': 'Вид',
  'menu.window': 'Окно',
  'menu.reconnect': 'Переподключить',
  'menu.stopService': 'Остановить фоновую службу…',
  'menu.about': 'О программе {product}',
  'menu.hide': 'Скрыть {product}',
  'menu.quit': 'Выйти из {product}',
  'stop.confirm.title': 'Остановить фоновую службу?',
  'stop.confirm.detail': 'Вместе с ней остановятся работающие агенты и загрузки. Закрытие окна или выход из {product} этого не делают.',
  'stop.confirm.stop': 'Остановить службу',
  'stop.confirm.cancel': 'Отмена',
  'stop.done': 'Фоновая служба остановлена.',
  'stop.not_managed': 'Эту службу запустило не {product}, поэтому отсюда она не останавливается.',
  'stop.not_running': 'Фоновая служба не запущена.',
  'stop.not_stopped': 'Служба (процесс {pid}) не остановилась вовремя.',
}

export const catalogues: Record<ShellLocale, Record<MessageKey, string>> = { en: english, ru: russian }

export function pickLocale(systemLocale: string): ShellLocale {
  return /^ru(?:[-_]|$)/i.test(systemLocale) ? 'ru' : 'en'
}

export function translate(
  locale: ShellLocale,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const template = catalogues[locale][key] ?? english[key]
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match))
}
