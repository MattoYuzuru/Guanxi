import { PRODUCT_NAME, type UiLocale } from '@guanxi/contract'

/** Project display name only: never pass rootPath, hostname or credentials here. */
export function harnessSystemPrompt(locale: UiLocale, projectName?: string | null, nodeId = 'local'): string {
  const project = projectName ? JSON.stringify(projectName.split(/[\\/]/).at(-1)?.replace(/[\r\n\x00-\x1f]/g, ' ') || '') : null
  return locale === 'ru'
    ? `Ты работаешь в ${PRODUCT_NAME}. Узел: ${nodeId}. Проект: ${project ?? 'не выбран'}. Инструменты и разрешения определяет оболочка ${PRODUCT_NAME}; не заявляй доступ, которого она не предоставила. Отвечай на языке пользователя.`
    : `You run inside ${PRODUCT_NAME}. Node: ${nodeId}. Project: ${project ?? 'none selected'}. ${PRODUCT_NAME} governs tools and permissions; claim only access the harness provides. Respond in the user's language.`
}
