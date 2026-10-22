import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError, ApiShapeError } from '../../src/lib/api.ts'
import { workspaceFailure, workspaceStep } from '../../src/features/workspace/failure.ts'

describe('workspace observed failures', () => {
  it('keeps only safe typed facts and fixes observation time before later rendering', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'))
    try {
      let failure: unknown
      try { await workspaceStep('save-layout', () => { throw new ApiRequestError(503, { code: 'internal_error', message: 'private-sentinel', details: { private: 'private-sentinel' } }, 'private-sentinel') }) } catch (error) { failure = error }
      vi.setSystemTime(new Date('2026-10-22T13:00:00.000Z'))
      const observed = workspaceFailure(failure, 'save-workspace')
      expect(observed.source).toBe('save-layout: PUT /api/layouts')
      expect(observed.observedAt).toBe('2026-10-22T12:00:00.000Z')
      expect(observed.details).toBe('source=save-layout: PUT /api/layouts\nobservedAt=2026-10-22T12:00:00.000Z\nkind=http\nstatus=503\ncode=internal_error')
      expect(JSON.stringify(observed)).not.toContain('private-sentinel')
    } finally { vi.useRealTimers() }
  })

  it('attributes a synchronous rejected snapshot to the actual local step without raw values', async () => {
    let failure: unknown
    try { await workspaceStep('snapshot-layout', () => { throw new Error('secret://private-sentinel') }) } catch (error) { failure = error }
    const observed = workspaceFailure(failure, 'save-workspace')
    expect(observed.operation).toBe('snapshot-layout')
    expect(observed.source).toBe('snapshot-layout')
    expect(observed.details).toContain('kind=unexpected')
    expect(observed.details).not.toContain('private-sentinel')
    expect(observed.details).not.toContain('/api/')
  })

  it('does not copy response-shape issue values or an arbitrary error name/message', () => {
    for (const error of [new ApiShapeError('/private-sentinel', [{ input: 'private-sentinel' }]), { name: 'private-sentinel', message: 'private-sentinel' }]) {
      const observed = workspaceFailure(error, 'load-layout-geometry')
      expect(observed.source).toBe('load-layout-geometry: GET /api/layouts/geometry')
      expect(JSON.stringify(observed)).not.toContain('private-sentinel')
    }
  })

  it('attributes concurrent failures independently rather than using a shared phase variable', async () => {
    const results = await Promise.allSettled([
      workspaceStep('load-developer-layouts', async () => { throw new TypeError('private-sentinel') }),
      workspaceStep('load-visual-layouts', async () => { throw new Error('private-sentinel') }),
    ])
    expect(results.map(result => result.status === 'rejected' && workspaceFailure(result.reason, 'load-workspace').operation))
      .toEqual(['load-developer-layouts', 'load-visual-layouts'])
  })
})
