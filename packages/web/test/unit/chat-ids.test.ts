import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// P3: ChatPage can be mounted more than once (a route and a workspace block), so element ids come
// from useId, never from string literals that would collide.
it('ChatPage uses no literal element ids or id references', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/features/chat/ChatPage.tsx'), 'utf8')
  const literal = [...source.matchAll(/\b(id|htmlFor|aria-(?:describedby|labelledby|controls))="[^"]+"/gu)].map(match => match[0])
  expect(literal).toEqual([])
})
