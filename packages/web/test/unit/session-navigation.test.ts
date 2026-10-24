import { describe, expect, it } from 'vitest'
import type { SessionPageItem } from '@guanxi/contract'
import { sessionNavigationPath, sessionViewPaths } from '../../src/features/shell/sessionNavigation.ts'
import { sessionIsOpen } from '../../src/features/shell/useUnseenSessions.ts'
import { parseRoute } from '../../src/lib/router.tsx'

describe('session navigation (round 4: one session view)', () => {
  it('opens a chat as the full-width session timeline, never the docking workspace', () => {
    const projectless = sessionNavigationPath({ kind: 'chat', threadId: 'thread-1', projectId: null })
    const inProject = sessionNavigationPath({ kind: 'chat', threadId: 'thread-2', projectId: 'project-a' })
    expect(projectless).toBe('/chat/thread-1')
    expect(inProject).toBe('/projects/project-a/chats/thread-2')
    expect(parseRoute(projectless)).toEqual({ name: 'chat', threadId: 'thread-1' })
    expect(parseRoute(inProject)).toEqual({ name: 'projectChat', projectId: 'project-a', threadId: 'thread-2' })
    for (const path of [projectless, inProject]) expect(path.startsWith('/workspace')).toBe(false)
  })

  it('keeps native and inspector sessions on their own views', () => {
    expect(sessionNavigationPath({ kind: 'native', sessionId: 'native-1' })).toBe('/agent/native-1')
    expect(sessionNavigationPath({ kind: 'inspector', sessionId: 'trace-1' })).toBe('/inspector/trace-1')
  })

  it('counts a chat as open in its timeline and in its free arrangement (review P2)', () => {
    const chat = { sessionId: 'session-1', navigation: { kind: 'chat', threadId: 'thread-1', projectId: 'project-a' } } as unknown as SessionPageItem
    expect(sessionViewPaths(chat.navigation)).toEqual(['/projects/project-a/chats/thread-1', '/workspace/thread-1?project=project-a', '/workspace/thread-1'])
    for (const location of ['/projects/project-a/chats/thread-1', '/workspace/thread-1?project=project-a', '/workspace/thread-1', '/inspector/session-1'])
      expect(sessionIsOpen(chat, location), location).toBe(true)
    for (const location of ['/chat/thread-2', '/workspace/thread-2', '/workspace']) expect(sessionIsOpen(chat, location), location).toBe(false)
  })

  it('keeps the free arrangement route parseable (public route, not the default)', () => {
    expect(parseRoute('/workspace/thread-1?project=project-a')).toEqual({ name: 'workspace', threadId: 'thread-1', projectId: 'project-a' })
  })
})
