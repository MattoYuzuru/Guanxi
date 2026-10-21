import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CatalogApp } from '../catalog/CatalogApp.tsx'
import { catalogEntries } from '../catalog/registry.ts'
import { ReviewPanel } from '../catalog/ReviewPanel.tsx'
import { ReviewApiError, type ReviewApi, type ReviewState } from '../catalog/review-api.ts'
import manifest from '../catalog/manifest.json'

const button = catalogEntries.find((entry) => entry.id === 'button')!

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    id: 'button',
    record: { id: 'button', status: 'draft', approval: null, requests: [] },
    current: { sourceHash: `sha256:${'a'.repeat(64)}`, snapshotHashes: {} },
    signature: 'absent',
    status: 'draft',
    ...overrides,
  }
}

function fakeApi(overrides: Partial<ReviewApi> = {}): ReviewApi {
  return {
    capability: vi.fn(async () => ({ writable: true, reason: null, keyId: 'ed25519:test' })),
    get: vi.fn(async () => state()),
    submit: vi.fn(async () => state({ status: 'approved', signature: 'valid' })),
    ...overrides,
  }
}

describe('catalog registry', () => {
  it('has one entry per manifest component and one story per declared state, in order', () => {
    expect(catalogEntries.map((entry) => entry.id).sort()).toEqual(manifest.components.map((component) => component.id).sort())
    for (const entry of catalogEntries) {
      expect(entry.stories.map((story) => story.name), entry.id).toEqual(entry.docs.states)
      expect(new Set(entry.stories.map((story) => story.key)).size).toBe(entry.stories.length)
    }
  })
})

describe('catalog overview', () => {
  it('renders every declared state of every component exactly once, without a failed story', async () => {
    const { container } = render(
      <CatalogApp entries={catalogEntries} chromeTheme="light" chromeLocale="en" reviewApi={null} />,
    )
    const expected = catalogEntries.flatMap((entry) => entry.stories.map((story) => story.key))
    await waitFor(() => expect(container.querySelectorAll('[data-story]').length).toBe(expected.length))
    expect([...container.querySelectorAll('[data-story]')].map((cell) => cell.getAttribute('data-story'))).toEqual(expected)
    expect(container.querySelectorAll('[data-story-error]').length).toBe(0)
  })
})

describe('review panel', () => {
  it('is read-only with the node reason and offers no actions', async () => {
    const api = fakeApi({ capability: vi.fn(async () => ({ writable: false, reason: 'release_build' as const, keyId: null })) })
    render(<ReviewPanel entry={button} api={api} />)
    expect(await screen.findByText('Release builds never write approvals.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('is read-only without a node', () => {
    render(<ReviewPanel entry={button} api={null} />)
    expect(screen.getByText('The node did not answer; showing the bundled records.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('approves with the hashes the node showed and reports the result', async () => {
    const api = fakeApi()
    render(<ReviewPanel entry={button} api={api} />)
    const approve = await screen.findByRole('button', { name: 'Approve' })
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: ' Good. ' } })
    await act(async () => {
      fireEvent.click(approve)
    })
    expect(api.submit).toHaveBeenCalledWith('button', {
      decision: 'approve',
      comment: 'Good.',
      expectedSourceHash: `sha256:${'a'.repeat(64)}`,
      expectedSnapshotHashes: {},
    })
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Approved and signed. The record was written to the repository.')
    expect(within(document.body).getAllByText('Approved').length).toBeGreaterThan(0)
  })

  it('requires a comment to request changes and maps a conflict', async () => {
    const api = fakeApi({ submit: vi.fn(async () => Promise.reject(new ReviewApiError('conflict', 'changed'))) })
    render(<ReviewPanel entry={button} api={api} />)
    const request = await screen.findByRole('button', { name: 'Request changes' })
    await act(async () => {
      fireEvent.click(request)
    })
    expect(api.submit).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Describe the change you need.')
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Tighter padding.' } })
    await act(async () => {
      fireEvent.click(request)
    })
    expect(screen.getByRole('status').textContent).toBe(
      'The component changed after this page loaded. Reload it and review the current version.',
    )
  })
})

describe('review binding', () => {
  const manifestHashes = { sourceHash: button.manifest!.sourceHash, snapshotHashes: button.manifest!.snapshotHashes }

  it('in a built bundle, signs the bundled hashes and refuses when the source moved on', async () => {
    const behind = fakeApi({ get: vi.fn(async () => state({ current: { sourceHash: `sha256:${'b'.repeat(64)}`, snapshotHashes: {} } })) })
    const { unmount } = render(<ReviewPanel entry={button} api={behind} binding="bundle" />)
    expect(await screen.findByText(/This build is older than the source on disk/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    unmount()

    const fresh = fakeApi({ get: vi.fn(async () => state({ current: manifestHashes })) })
    render(<ReviewPanel entry={button} api={fresh} binding="bundle" />)
    const approve = await screen.findByRole('button', { name: 'Approve' })
    await act(async () => {
      fireEvent.click(approve)
    })
    expect(fresh.submit).toHaveBeenCalledWith('button', expect.objectContaining({ expectedSourceHash: manifestHashes.sourceHash }))
  })

  it('reads the record again after a conflict', async () => {
    const api = fakeApi({ submit: vi.fn(async () => Promise.reject(new ReviewApiError('conflict', 'changed'))) })
    render(<ReviewPanel entry={button} api={api} />)
    const approve = await screen.findByRole('button', { name: 'Approve' })
    await act(async () => {
      fireEvent.click(approve)
    })
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })

  it('updates the page header status once the node reports it', async () => {
    const api = fakeApi({ get: vi.fn(async () => state({ status: 'stale', signature: 'valid' })) })
    render(
      <CatalogApp
        entries={catalogEntries}
        chromeTheme="light"
        chromeLocale="en"
        reviewApi={api}
        initialView={{ kind: 'component', id: 'button' }}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    await waitFor(() => expect(document.querySelector('.gx-catalog-page-head [data-status]')?.getAttribute('data-status')).toBe('stale'))
  })
})
