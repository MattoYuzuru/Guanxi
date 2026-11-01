/** English source with curated Russian for the launcher's safe-mode recovery surface. */
const messages = {
  en: {
    safeModeHelp: 'Start core only; skip installed plugins',
    safeModeAlreadyRunning: 'Safe mode requires a stopped node. Stop the existing node, then start with --safe-mode.',
  },
  ru: {
    safeModeHelp: 'Запустить только ядро, без установленных плагинов',
    safeModeAlreadyRunning: 'Безопасный режим требует остановленного узла. Остановите текущий узел и запустите с --safe-mode.',
  },
}
export const pluginMessages = /^(ru)(?:[_\-.]|$)/i.test(process.env['LC_ALL'] || process.env['LANG'] || '') ? messages.ru : messages.en
