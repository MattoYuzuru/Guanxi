import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TrackerSyncEngine } from '../../../src/work/sync/engine.ts'
import { GitHubAdapter } from '../../../src/work/sync/github.ts'
import { JiraAdapter, adfToText } from '../../../src/work/sync/jira.ts'
import { RateLimitGovernor } from '../../../src/work/sync/rate-limit.ts'
import type {
  HttpRequest,
  HttpResponse,
  TrackerLink,
} from '../../../src/work/sync/types.ts'

const START = Date.parse('2026-10-20T12:00:00Z')
const TOKEN = 'ghp_WG2A_engine_token_987654321'
const EXTERNAL_KEY = 'example-org/example-repo#7'

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as T
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

function link(overrides: Partial<TrackerLink> = {}): TrackerLink {
  return {
    itemId: 'wg2-a',
    tracker: 'github',
    externalKey: EXTERNAL_KEY,
    lastSyncedStatus: null,
    lastRemoteEtag: null,
    lastRemoteUpdatedAt: null,
    lastCommentId: null,
    lastTransitionSeq: 0,
    ...overrides,
  }
}

interface FakeIssue {
  title: string
  body: string
  labels: string[]
  assignee: string
  updated_at: string
}

function issueFromFixture(name: string): FakeIssue {
  const raw = fixture<{
    title: string
    body: string
    labels: Array<{ name: string }>
    assignee: { login: string }
    updated_at: string
  }>(name)
  return {
    title: raw.title,
    body: raw.body,
    labels: raw.labels.map(label => label.name),
    assignee: raw.assignee.login,
    updated_at: raw.updated_at,
  }
}

class FakeGitHub {
  readonly requests: HttpRequest[] = []
  readonly comments: Array<{ id: number; body: string }> = fixture('github-comments-empty')
  issue = issueFromFixture('github-issue-initial')
  etag = 'W/"issue-1"'
  failNextCommentAfterRecord = false
  failNextLabelPost = false
  private nextCommentId = 9000

  setRemote(next: FakeIssue, etag = 'W/"issue-2"'): void {
    this.issue = { ...next, labels: [...next.labels] }
    this.etag = etag
  }

  commentPosts(): HttpRequest[] {
    return this.requests.filter(
      request => request.method === 'POST' && /\/issues\/7\/comments$/.test(new URL(request.url).pathname),
    )
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(request))
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && /\/issues\/7$/.test(path)) {
      if (request.headers['if-none-match'] === this.etag) {
        return { status: 304, headers: {}, body: '' }
      }
      return json(200, this.issuePayload(), { etag: this.etag })
    }
    if (request.method === 'GET' && /\/issues\/7\/comments$/.test(path)) {
      return json(200, this.comments)
    }
    if (request.method === 'POST' && /\/issues\/7\/comments$/.test(path)) {
      const body = JSON.parse(request.body ?? '{}') as { body?: string }
      const comment = { id: this.nextCommentId++, body: body.body ?? '' }
      this.comments.push(comment)
      if (this.failNextCommentAfterRecord) {
        this.failNextCommentAfterRecord = false
        throw new Error('simulated crash after the comment POST')
      }
      return json(201, comment)
    }
    if (request.method === 'DELETE' && path.includes('/labels/')) {
      const label = decodeURIComponent(path.split('/').at(-1) ?? '')
      this.issue = { ...this.issue, labels: this.issue.labels.filter(entry => entry !== label) }
      return json(200, this.issue.labels.map(name => ({ name })))
    }
    if (request.method === 'POST' && /\/issues\/7\/labels$/.test(path)) {
      if (this.failNextLabelPost) {
        this.failNextLabelPost = false
        return json(500, { message: 'upstream failed' })
      }
      const body = JSON.parse(request.body ?? '{}') as { labels?: string[] }
      for (const label of body.labels ?? []) {
        if (!this.issue.labels.includes(label)) this.issue.labels.push(label)
      }
      return json(200, this.issue.labels.map(name => ({ name })))
    }
    throw new Error(`unexpected fake GitHub request ${request.method} ${path}`)
  }

  private issuePayload(): Record<string, unknown> {
    return {
      id: 1007,
      number: 7,
      title: this.issue.title,
      body: this.issue.body,
      labels: this.issue.labels.map(name => ({ name })),
      assignee: { login: this.issue.assignee },
      assignees: [{ login: this.issue.assignee }],
      updated_at: this.issue.updated_at,
    }
  }
}

class FakeJira {
  readonly requests: HttpRequest[] = []
  issue: Record<string, unknown> = fixture('jira-issue-v3')
  readonly comments: Array<{ id: string; body: unknown }> = []
  readonly transitionPosts: string[] = []
  private nextCommentId = 20_000

  setRemote(next: Record<string, unknown>): void {
    this.issue = next
  }

  commentPosts(): HttpRequest[] {
    return this.requests.filter(
      request => request.method === 'POST'
        && /\/issue\/PROJ-12\/comment$/.test(new URL(request.url).pathname),
    )
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(request))
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && /\/issue\/PROJ-12$/.test(path)) {
      return json(200, this.issue)
    }
    if (request.method === 'GET' && /\/issue\/PROJ-12\/comment$/.test(path)) {
      return json(200, {
        startAt: 0,
        maxResults: 100,
        total: this.comments.length,
        comments: this.comments,
      })
    }
    if (request.method === 'POST' && /\/issue\/PROJ-12\/comment$/.test(path)) {
      const payload = JSON.parse(request.body ?? '{}') as { body?: unknown }
      const comment = { id: String(this.nextCommentId++), body: payload.body }
      this.comments.push(comment)
      return json(201, comment)
    }
    if (request.method === 'GET' && /\/issue\/PROJ-12\/transitions$/.test(path)) {
      return json(200, fixture('jira-transitions-v3'))
    }
    if (request.method === 'POST' && /\/issue\/PROJ-12\/transitions$/.test(path)) {
      const payload = JSON.parse(request.body ?? '{}') as { transition?: { id?: string } }
      this.transitionPosts.push(payload.transition?.id ?? '')
      return { status: 204, headers: {}, body: '' }
    }
    throw new Error(`unexpected fake Jira request ${request.method} ${path}`)
  }
}

function githubEngine(fake: FakeGitHub, token = TOKEN): {
  engine: TrackerSyncEngine
  adapter: GitHubAdapter
} {
  const adapter = new GitHubAdapter({
    http: request => fake.request(request),
    authorize: headers => {
      headers.authorization = `Bearer ${token}`
    },
    credential: 'secret://vault/github/default',
  })
  return { engine: new TrackerSyncEngine({ adapter, now: () => START }), adapter }
}

test('business fields stay read-only while display metadata follows the remote', async () => {
  const fake = new FakeGitHub()
  const { engine } = githubEngine(fake)
  const initial = await engine.poll(link(), START)
  assert.equal(initial.notModified, false)
  assert.equal(initial.changed, true)
  assert.equal(initial.metadata?.title, 'Add tracker sync')

  const started = await engine.sync(initial.link, 'in_progress', { now: START + 1 })
  assert.equal(started.outcome, 'synced')
  assert.equal(started.commentPosted, true)
  assert.deepEqual(
    fake.issue.labels.filter(label => label.startsWith('guanxi:')),
    ['guanxi:in_progress'],
  )

  fake.setRemote(issueFromFixture('github-issue-updated'))
  const updated = await engine.poll(started.link, START + 2)
  assert.equal(updated.notModified, false)
  assert.equal(updated.changed, true)
  assert.deepEqual(
    updated.changes.map(change => change.field).sort(),
    ['assignee', 'description', 'labels', 'priority', 'title'],
  )
  assert.equal(updated.metadata?.title, 'Add tracker sync (remote edit)')
  assert.equal(updated.metadata?.description, 'Updated description owned by the tracker.')
  assert.equal(updated.metadata?.priority, 'urgent')
  assert.equal(updated.metadata?.assignee, 'remote-editor')
  assert.ok(updated.metadata?.labels.includes('priority:urgent'))
  assert.equal(updated.metadata?.labels.some(label => label.startsWith('guanxi:')), false)

  const blocked = await engine.sync(updated.link, 'blocked', { now: START + 3 })
  assert.equal(blocked.commentPosted, true)
  const done = await engine.sync(blocked.link, 'done', {
    now: START + 4,
    evidence: { url: 'https://example.test/commits/abc123' },
  })
  assert.equal(done.commentPosted, true)
  assert.match(
    fake.comments.at(-1)!.body,
    /Evidence: https:\/\/example\.test\/commits\/abc123/,
  )

  const verified = await engine.sync(done.link, 'verification_requested', { now: START + 5 })
  assert.equal(verified.outcome, 'synced')
  assert.deepEqual(verified.writes, [])
  assert.equal(fake.comments.length, 3)

  const metadata = engine.metadata('wg2-a')!
  assert.equal(metadata.title, 'Add tracker sync (remote edit)')
  assert.equal(metadata.description, 'Updated description owned by the tracker.')
  assert.equal(metadata.priority, 'urgent')
  assert.equal(metadata.assignee, 'remote-editor')

  const forbidden = [
    'Add tracker sync (remote edit)',
    'Updated description owned by the tracker.',
    'priority:urgent',
    'remote-editor',
  ]
  for (const request of fake.requests) {
    assert.ok(request.method !== 'PATCH' && request.method !== 'PUT')
    for (const value of forbidden) {
      assert.equal(request.url.includes(value), false)
      assert.equal((request.body ?? '').includes(value), false)
    }
    if (request.method === 'POST' && /\/comments$/.test(new URL(request.url).pathname)) {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>
      assert.deepEqual(Object.keys(body), ['body'])
    }
    if (request.method === 'POST' && /\/labels$/.test(new URL(request.url).pathname)) {
      const body = JSON.parse(request.body ?? '{}') as { labels: string[] }
      assert.deepEqual(Object.keys(body), ['labels'])
      assert.ok(body.labels.every(label => label.startsWith('guanxi:')))
    }
  }
})

test('exactly one marked comment is posted per coarse transition', async () => {
  const fake = new FakeGitHub()
  const { engine } = githubEngine(fake)
  let current = link()
  const statuses = ['in_progress', 'blocked', 'done', 'done', 'ready', 'in_progress'] as const
  let now = START
  for (const status of statuses) {
    now += 10
    const result = await engine.sync(current, status, { now })
    current = result.link
  }

  assert.equal(fake.comments.length, 4)
  assert.equal(fake.commentPosts().length, 4)
  const markers = fake.comments.map(comment => {
    const match = /<!-- guanxi:transition:[^>]+ -->/.exec(comment.body)
    assert.ok(match !== null)
    return match[0]
  })
  assert.equal(new Set(markers).size, 4)
  for (const marker of markers) {
    assert.equal(markers.filter(entry => entry === marker).length, 1)
  }
  assert.ok(markers.some(marker => marker.includes(':in_progress:1 -->')))
  assert.ok(markers.some(marker => marker.includes(':blocked:2 -->')))
  assert.ok(markers.some(marker => marker.includes(':done:3 -->')))
  assert.ok(markers.some(marker => marker.includes(':in_progress:4 -->')))
  assert.equal(current.lastTransitionSeq, 4)
  assert.equal(current.lastSyncedStatus, 'in_progress')
  assert.deepEqual(
    fake.issue.labels.filter(label => label.startsWith('guanxi:')),
    ['guanxi:in_progress'],
  )
})

test('the label swap audits only Guanxi status labels and keeps guanxi:needs-triage', async () => {
  const fake = new FakeGitHub()
  fake.setRemote({
    ...issueFromFixture('github-issue-initial'),
    labels: ['bug', 'guanxi:needs-triage', 'guanxi:in_progress'],
  })
  const { engine } = githubEngine(fake)
  const initial = link({ lastSyncedStatus: 'in_progress' })
  const result = await engine.sync(initial, 'done', { now: START })
  assert.equal(result.outcome, 'synced')

  const deletions = fake.requests
    .filter(request => request.method === 'DELETE')
    .map(request => decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) ?? ''))
  assert.deepEqual(deletions, ['guanxi:in_progress'])
  assert.equal(
    fake.requests.some(request => request.url.includes('needs-triage')),
    false,
  )
  assert.deepEqual(
    fake.issue.labels.filter(label => label.startsWith('guanxi:')).sort(),
    ['guanxi:done', 'guanxi:needs-triage'],
  )
})

test('a crash between comment POST and local save does not double-post', async () => {
  const fake = new FakeGitHub()
  fake.failNextCommentAfterRecord = true
  const { engine } = githubEngine(fake)
  const initial = link()

  const crashed = await engine.sync(initial, 'in_progress', { now: START })
  assert.equal(crashed.outcome, 'deferred')
  assert.equal(crashed.deferred?.reason, 'server_backoff')
  assert.equal(crashed.deferred?.nextAllowedAt, START + 1_000)
  assert.equal(fake.comments.length, 1)
  assert.equal(fake.commentPosts().length, 1)
  assert.equal(crashed.link.lastTransitionSeq, 0)

  const retried = await engine.sync(initial, 'in_progress', {
    now: crashed.deferred!.nextAllowedAt,
  })
  assert.equal(retried.outcome, 'synced')
  assert.equal(retried.commentPosted, false)
  assert.equal(retried.writes[0]?.skipped, true)
  assert.equal(fake.comments.length, 1)
  assert.equal(fake.commentPosts().length, 1)
  assert.equal(retried.link.lastTransitionSeq, 1)
  assert.equal(retried.link.lastCommentId, '9000')
})

test('a deferred label write after a posted comment keeps the same marker on retry', async () => {
  const fake = new FakeGitHub()
  fake.failNextLabelPost = true
  const { engine } = githubEngine(fake)
  const initial = link()

  const deferred = await engine.sync(initial, 'in_progress', { now: START })
  assert.equal(deferred.outcome, 'deferred')
  assert.equal(deferred.commentPosted, true)
  assert.equal(fake.comments.length, 1)
  assert.equal(fake.commentPosts().length, 1)
  // The transition is not saved until the label succeeds, so the sequence is unchanged.
  assert.equal(deferred.link.lastTransitionSeq, 0)

  const retried = await engine.sync(initial, 'in_progress', {
    now: deferred.deferred!.nextAllowedAt,
  })
  assert.equal(retried.outcome, 'synced')
  assert.equal(retried.commentPosted, false)
  assert.equal(fake.comments.length, 1)
  assert.equal(fake.commentPosts().length, 1)
  assert.equal(retried.link.lastTransitionSeq, 1)
})

test('transitions outside the coarse set send no request of any kind', async () => {
  const fake = new FakeGitHub()
  const { engine } = githubEngine(fake)
  let current = link()
  let now = START
  for (const status of ['ready', 'verification_requested', 'canceled', 'proposed'] as const) {
    now += 10
    const result = await engine.sync(current, status, { now })
    assert.equal(result.outcome, 'synced')
    assert.deepEqual(result.writes, [])
    assert.equal(result.commentPosted, false)
    current = result.link
  }
  assert.equal(fake.requests.length, 0)
  assert.equal(fake.comments.length, 0)
  assert.equal(current.lastSyncedStatus, 'proposed')
})

test('Jira comments every coarse transition and only transitions mapped statuses', async () => {
  const fake = new FakeJira()
  const adapter = new JiraAdapter({
    http: request => fake.request(request),
    authorize: headers => {
      headers.authorization = `Bearer ${TOKEN}`
    },
    credential: 'secret://vault/jira/default',
    baseUrl: 'https://jira.example.test',
    apiVersion: 3,
    transitions: { in_progress: '21' },
  })
  const engine = new TrackerSyncEngine({ adapter, now: () => START })
  let current = link({ tracker: 'jira', externalKey: 'PROJ-12' })

  const initial = await engine.poll(current, START)
  assert.equal(initial.metadata?.title, 'Add tracker sync')
  assert.equal(initial.metadata?.description, 'Initial description from Jira Cloud.')
  fake.setRemote(fixture('jira-issue-v3-updated'))
  const changed = await engine.poll(initial.link, START + 1)
  assert.equal(changed.changed, true)
  assert.equal(changed.metadata?.title, 'Add tracker sync (remote edit)')
  assert.equal(changed.metadata?.description, 'Updated description owned by Jira Cloud.')
  assert.equal(changed.metadata?.priority, 'Highest')
  assert.equal(changed.metadata?.assignee, 'Remote Editor')
  current = changed.link

  const started = await engine.sync(current, 'in_progress', { now: START + 2 })
  assert.equal(started.commentPosted, true)
  assert.deepEqual(fake.transitionPosts, ['21'])
  assert.deepEqual(started.writes.map(write => write.kind), ['comment', 'transition'])
  current = started.link

  const blocked = await engine.sync(current, 'blocked', { now: START + 3 })
  assert.equal(blocked.commentPosted, true)
  assert.deepEqual(blocked.writes.map(write => write.kind), ['comment'])
  assert.deepEqual(fake.transitionPosts, ['21'])
  current = blocked.link

  const done = await engine.sync(current, 'done', { now: START + 4 })
  assert.equal(done.commentPosted, true)
  assert.deepEqual(fake.transitionPosts, ['21'])
  assert.equal(fake.comments.length, 3)
  assert.equal(fake.commentPosts().length, 3)
  for (const comment of fake.comments) {
    assert.match(adfToText(comment.body), /guanxi:transition:wg2-a:/)
  }
})

test('conditional polling returns 304 without touching metadata', async () => {
  const fake = new FakeGitHub()
  const { engine } = githubEngine(fake)
  const first = await engine.poll(link(), START)
  assert.equal(first.changed, true)
  const metadata = engine.metadata('wg2-a')

  const second = await engine.poll(first.link, START + 1)
  assert.equal(second.notModified, true)
  assert.equal(second.changed, false)
  assert.deepEqual(second.changes, [])
  assert.deepEqual(second.link, first.link)
  assert.deepEqual(second.metadata, metadata)
  assert.equal(fake.requests[1]!.headers['if-none-match'], fake.etag)
})

test('the engine defers a budgeted write and the caller retries at the exact time', async () => {
  const fake = new FakeGitHub()
  const governor = new RateLimitGovernor({ now: () => START })
  const adapter = new GitHubAdapter({
    http: request => fake.request(request),
    authorize: headers => {
      headers.authorization = `Bearer ${TOKEN}`
    },
    credential: 'secret://vault/github/default',
  })
  for (let index = 0; index < 80; index++) {
    assert.equal(
      governor.checkWrite({
        tracker: 'github', key: EXTERNAL_KEY, contentCreation: true, now: START,
      }).allowed,
      true,
    )
  }
  const engine = new TrackerSyncEngine({ adapter, governor, now: () => START })
  const deferred = await engine.sync(link(), 'in_progress', { now: START })
  assert.equal(deferred.outcome, 'deferred')
  assert.equal(deferred.deferred?.reason, 'content_budget')
  assert.equal(deferred.deferred?.nextAllowedAt, START + 750)
  assert.equal(fake.commentPosts().length, 0)
  assert.equal(fake.comments.length, 0)

  const retried = await engine.sync(link(), 'in_progress', {
    now: deferred.deferred!.nextAllowedAt,
  })
  assert.equal(retried.outcome, 'synced')
  assert.equal(fake.commentPosts().length, 1)
  assert.equal(fake.comments.length, 1)
})

test('engine results and request bodies never carry the planted credential', async () => {
  const fake = new FakeGitHub()
  const { engine } = githubEngine(fake, TOKEN)
  const polled = await engine.poll(link(), START)
  const synced = await engine.sync(polled.link, 'in_progress', { now: START + 1 })
  const allResults = JSON.stringify({
    polled,
    synced,
    link: engine.link('wg2-a'),
    metadata: engine.metadata('wg2-a'),
  })
  assert.equal(allResults.includes(TOKEN), false)

  for (const request of fake.requests) {
    assert.equal(request.url.includes(TOKEN), false)
    assert.equal((request.body ?? '').includes(TOKEN), false)
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === 'authorization') {
        assert.equal(value, `Bearer ${TOKEN}`)
      } else {
        assert.equal(value.includes(TOKEN), false)
      }
    }
  }
})
