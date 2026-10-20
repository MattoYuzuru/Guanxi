export type ExistingGuanxi =
  | { kind: 'ui'; url: string }
  | { kind: 'api-only'; url: string; version: string | null }

/**
 * Отличает уже запущенный Guanxi от произвольного процесса на том же порту.
 *
 * Проверяем корневую страницу, а не /api/health: health может ждать таймаут
 * выключенной Ollama, тогда как HTML доступен сразу.
 */
export async function probeExistingGuanxi(
  url: string,
  timeoutMs = 1_200,
): Promise<ExistingGuanxi | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html' },
      signal: controller.signal,
    })
    if (!response.ok) return null

    const body = await response.text()
    if (body.includes('<title>Guanxi</title>') && /<div\s+id=["']root["']/.test(body)) {
      return { kind: 'ui', url }
    }

    if (body.includes('Сборка фронта не найдена')) {
      const version = body.match(/Guanxi ([^\s<]+)/)?.[1] ?? null
      return { kind: 'api-only', url, version }
    }

    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
