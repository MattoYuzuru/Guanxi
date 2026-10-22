import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { GitHubAdapter } from '../../../src/work/sync/github.ts'
import { JiraAdapter, adfToText } from '../../../src/work/sync/jira.ts'
import {
  TrackerRetryableError,
  TrackerSyncError,
  type HttpHeaders,
  type HttpRequest,
  type HttpResponse,
  type TrackerMutation,
} from '../../../src/work/sync/types.ts'

const NOW = '2026-10-20T12:00:00.000Z'

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as T
}

function json(status: number, body: unknown, headers: HttpHeaders = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

class ScriptedTransport {
  readonly requests: HttpRequest[] = []
  private readonly handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>

  constructor(handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
    this.handler = handler
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(request))
    return this.handler(request)
  }
}

function authorize(headers: HttpHeaders): void {
  headers.authorization = 'Bearer test-token-value'
}

function githubAdapter(transport: ScriptedTransport): GitHubAdapter {
  return new GitHubAdapter({
    http: request => transport.request(request),
    authorize,
    credential: 'secret://vault/github/default',
  })
}

function jiraAdapter(
  transport: ScriptedTransport,
  apiVersion: 2 | 3,
  transitions?: Partial<Record<'in_progress' | 'blocked' | 'failed' | 'done', string>>,
): JiraAdapter {
  return new JiraAdapter({
    http: request => transport.request(request),
    authorize,
    credential: 'secret://vault/jira/default',
    baseUrl: 'https://jira.example.test',
    apiVersion,
    ...(transitions === undefined ? {} : { transitions }),
  })
}

function pathOf(request: HttpRequest): string {
  return new URL(request.url).pathname
}

test('GitHub reads business fields and honours ETag conditionals', async () => {
  const initial = fixture<Record<string, unknown>>('github-issue-initial')
  const transport = new ScriptedTransport(request => {
    if (request.headers['if-none-match'] === 'W/"issue-1"') {
      return { status: 304, headers: {}, body: '' }
    }
    return json(200, initial, { etag: 'W/"issue-1"' })
  })
  const adapter = githubAdapter(transport)
  assert.equal(adapter.tracker, 'github')
  assert.equal(adapter.credential, 'secret://vault/github/default')

  const first = await adapter.read('example-org/example-repo#7')
  assert.equal(first.notModified, false)
  if (first.notModified) return
  assert.equal(first.fields.title, 'Add tracker sync')
  assert.equal(first.fields.description, 'Initial description from the tracker.')
  assert.equal(first.fields.priority, 'high')
  assert.equal(first.fields.assignee, 'tracker-user')
  assert.deepEqual(first.fields.labels, ['bug', 'priority:high'])
  assert.equal(first.etag, 'W/"issue-1"')
  assert.equal(first.updatedAt, '2026-10-20T12:00:00Z')
  assert.match(transport.requests[0]!.headers.authorization ?? '', /^Bearer /)
  assert.equal(transport.requests[0]!.headers.accept, 'application/vnd.github+json')

  const second = await adapter.read('example-org/example-repo#7', {
    etag: first.etag,
    updatedAt: first.updatedAt,
  })
  assert.deepEqual(second, { notModified: true })
  assert.equal(transport.requests[1]!.headers['if-none-match'], 'W/"issue-1"')
  assert.equal(
    transport.requests[1]!.headers['if-modified-since'],
    new Date(NOW).toUTCString(),
  )
})

test('Jira v3 and v2 read the same business model with version-specific descriptions', async () => {
  const v3Transport = new ScriptedTransport(() => json(200, fixture('jira-issue-v3')))
  const v3 = await jiraAdapter(v3Transport, 3).read('PROJ-12')
  assert.equal(v3.notModified, false)
  if (!v3.notModified) {
    assert.equal(v3.fields.title, 'Add tracker sync')
    assert.equal(v3.fields.description, 'Initial description from Jira Cloud.')
    assert.equal(v3.fields.priority, 'High')
    assert.equal(v3.fields.assignee, 'Tracker User')
    assert.deepEqual(v3.fields.labels, ['backend'])
    assert.equal(v3.updatedAt, '2026-10-20T12:00:00.000+0000')
  }
  assert.equal(pathOf(v3Transport.requests[0]!), '/rest/api/3/issue/PROJ-12')

  const v2Transport = new ScriptedTransport(() => json(200, fixture('jira-issue-v2')))
  const v2 = await jiraAdapter(v2Transport, 2).read('PROJ-12')
  assert.equal(v2.notModified, false)
  if (!v2.notModified) {
    assert.equal(v2.fields.description, 'Initial description from Jira Data Center.')
    assert.equal(v2.fields.assignee, 'tracker-user')
  }
  assert.equal(pathOf(v2Transport.requests[0]!), '/rest/api/2/issue/PROJ-12')
})

test('Jira conditional polling returns 304 without changes', async () => {
  let calls = 0
  const transport = new ScriptedTransport(request => {
    calls += 1
    if (calls === 1) return json(200, fixture('jira-issue-v3'), { etag: 'W/"jira-1"' })
    assert.equal(request.headers['if-none-match'], 'W/"jira-1"')
    return { status: 304, headers: {}, body: '' }
  })
  const adapter = jiraAdapter(transport, 3)
  const first = await adapter.read('PROJ-12')
  assert.equal(first.notModified, false)
  if (first.notModified) return
  const second = await adapter.read('PROJ-12', { etag: first.etag })
  assert.deepEqual(second, { notModified: true })
})

test('GitHub comment reads and writes carry only the comment body', async () => {
  const marker = '<!-- guanxi:transition:wg2-a:in_progress:1 -->'
  const transport = new ScriptedTransport(request => {
    if (request.method === 'GET') return json(200, fixture('github-comments-with-marker'))
    return json(201, fixture('github-comment-created'))
  })
  const adapter = githubAdapter(transport)
  const comments = await adapter.listComments('example-org/example-repo#7')
  assert.equal(comments.length, 1)
  assert.equal(comments[0]!.id, '9001')
  assert.equal(comments[0]!.author, 'tracker-bot')
  assert.match(comments[0]!.body, /guanxi:transition:wg2-a:in_progress:1/)

  const created = await adapter.mutate('example-org/example-repo#7', {
    kind: 'comment',
    body: `Guanxi item is now in_progress.\n\n${marker}`,
    marker,
  })
  assert.equal(created.commentId, '9100')
  const payload = JSON.parse(transport.requests[1]!.body ?? '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(payload), ['body'])
  assert.match(String(payload.body), /guanxi:transition:wg2-a:in_progress:1/)
})

test('GitHub swaps exactly one guanxi status label and refuses business writes', async () => {
  const issue = fixture<{ labels: Array<{ name: string }> }>('github-issue-initial')
  issue.labels = [{ name: 'bug' }, { name: 'guanxi:in_progress' }]
  const transport = new ScriptedTransport(request => {
    const path = pathOf(request)
    if (request.method === 'GET' && /\/issues\/7$/.test(path)) return json(200, issue)
    if (request.method === 'DELETE') {
      const label = decodeURIComponent(path.split('/').at(-1) ?? '')
      issue.labels = issue.labels.filter(entry => entry.name !== label)
      return json(200, issue.labels)
    }
    if (request.method === 'POST' && /\/labels$/.test(path)) {
      const body = JSON.parse(request.body ?? '{}') as { labels?: string[] }
      for (const label of body.labels ?? []) issue.labels.push({ name: label })
      return json(200, issue.labels)
    }
    throw new Error(`unexpected GitHub label request ${request.method} ${path}`)
  })
  const adapter = githubAdapter(transport)
  const first = await adapter.mutate('example-org/example-repo#7', {
    kind: 'status-label',
    status: 'done',
  })
  assert.equal(first.status, 200)
  assert.equal(first.skipped, undefined)
  assert.deepEqual(issue.labels.map(label => label.name), ['bug', 'guanxi:done'])
  assert.deepEqual(transport.requests.map(request => request.method), ['GET', 'DELETE', 'POST'])
  const body = JSON.parse(transport.requests[2]!.body ?? '{}') as { labels: string[] }
  assert.deepEqual(body, { labels: ['guanxi:done'] })
  assert.deepEqual(Object.keys(body), ['labels'])
  assert.ok(
    decodeURIComponent(transport.requests[1]!.url).endsWith('/labels/guanxi:in_progress'),
  )
  assert.ok(transport.requests.every(request => request.method !== 'PATCH' && request.method !== 'PUT'))

  const before = transport.requests.length
  const second = await adapter.mutate('example-org/example-repo#7', {
    kind: 'status-label',
    status: 'done',
  })
  assert.equal(second.skipped, true)
  // The adapter re-reads labels to decide there is nothing to write; the skipped mutation
  // itself sends no label request.
  assert.equal(transport.requests.length, before + 1)
  assert.equal(transport.requests.at(-1)!.method, 'GET')

  await assert.rejects(
    adapter.mutate('example-org/example-repo#7', {
      kind: 'issue-update',
      fields: { title: 'Overwrite the tracker title' },
    } as unknown as TrackerMutation),
    (error: unknown) => {
      assert.ok(error instanceof TrackerSyncError)
      assert.equal(error.code, 'business_field_write_refused')
      return true
    },
  )
  assert.equal(transport.requests.length, before + 1)
})

test('GitHub keeps user labels in the guanxi namespace out of the status swap', async () => {
  const issue = fixture<{ labels: Array<{ name: string }> }>('github-issue-initial')
  issue.labels = [
    { name: 'bug' },
    { name: 'guanxi:needs-triage' },
    { name: 'guanxi:in_progress' },
  ]
  const transport = new ScriptedTransport(request => {
    const path = pathOf(request)
    if (request.method === 'GET' && /\/issues\/7$/.test(path)) return json(200, issue)
    if (request.method === 'DELETE') {
      const label = decodeURIComponent(path.split('/').at(-1) ?? '')
      issue.labels = issue.labels.filter(entry => entry.name !== label)
      return json(200, issue.labels)
    }
    if (request.method === 'POST' && /\/labels$/.test(path)) {
      const body = JSON.parse(request.body ?? '{}') as { labels?: string[] }
      for (const label of body.labels ?? []) issue.labels.push({ name: label })
      return json(200, issue.labels)
    }
    throw new Error(`unexpected GitHub label request ${request.method} ${path}`)
  })
  const adapter = githubAdapter(transport)

  const read = await adapter.read('example-org/example-repo#7')
  assert.equal(read.notModified, false)
  if (!read.notModified) {
    assert.deepEqual(read.fields.labels, ['bug', 'guanxi:needs-triage'])
  }

  await adapter.mutate('example-org/example-repo#7', { kind: 'status-label', status: 'done' })
  const deletions = transport.requests.filter(request => request.method === 'DELETE')
  assert.deepEqual(
    deletions.map(request => decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) ?? '')),
    ['guanxi:in_progress'],
  )
  assert.equal(
    deletions.some(request => request.url.includes('needs-triage')),
    false,
  )
  assert.deepEqual(
    issue.labels.map(label => label.name).sort(),
    ['bug', 'guanxi:done', 'guanxi:needs-triage'],
  )
})

test('adapters expose the authenticated identity and cache it', async () => {
  const github = new ScriptedTransport(request => {
    if (pathOf(request) === '/user') return json(200, { login: 'tracker-bot' })
    throw new Error(`unexpected GitHub request ${request.method} ${pathOf(request)}`)
  })
  const gitHubAdapter = githubAdapter(github)
  assert.equal(await gitHubAdapter.self(), 'tracker-bot')
  assert.equal(await gitHubAdapter.self(), 'tracker-bot')
  assert.equal(github.requests.length, 1)
  assert.equal(pathOf(github.requests[0]!), '/user')

  const jira = new ScriptedTransport(request => {
    if (pathOf(request) === '/rest/api/3/myself') return json(200, { accountId: 'jira-bot' })
    throw new Error(`unexpected Jira request ${request.method} ${pathOf(request)}`)
  })
  const jiraV3 = jiraAdapter(jira, 3)
  assert.equal(await jiraV3.self(), 'jira-bot')
  assert.equal(await jiraV3.self(), 'jira-bot')
  assert.equal(jira.requests.length, 1)

  const jiraV2Transport = new ScriptedTransport(request => {
    if (pathOf(request) === '/rest/api/2/myself') return json(200, { name: 'data-center-bot' })
    throw new Error(`unexpected Jira request ${request.method} ${pathOf(request)}`)
  })
  assert.equal(await jiraAdapter(jiraV2Transport, 2).self(), 'data-center-bot')
})

test('retryable read responses surface as a typed retryable error', async () => {
  const github = new ScriptedTransport(() => json(429, { message: 'rate limited' }, {
    'retry-after': '30',
  }))
  await assert.rejects(
    githubAdapter(github).listComments('example-org/example-repo#7'),
    (error: unknown) => {
      assert.ok(error instanceof TrackerRetryableError)
      assert.equal(error.code, 'retryable_response')
      assert.equal(error.status, 429)
      assert.equal(error.headers['retry-after'], '30')
      return true
    },
  )

  const jira = new ScriptedTransport(() => json(503, { message: 'maintenance' }))
  await assert.rejects(
    jiraAdapter(jira, 3).read('PROJ-12'),
    (error: unknown) => {
      assert.ok(error instanceof TrackerRetryableError)
      assert.equal(error.status, 503)
      return true
    },
  )
})

test('Jira maps statuses to transitions and leaves unmapped statuses comment-only', async () => {
  const applied: string[] = []
  const transport = new ScriptedTransport(request => {
    const path = pathOf(request)
    if (request.method === 'GET' && path.endsWith('/transitions')) {
      return json(200, fixture('jira-transitions-v3'))
    }
    if (request.method === 'POST' && path.endsWith('/transitions')) {
      const body = JSON.parse(request.body ?? '{}') as { transition: { id: string } }
      applied.push(body.transition.id)
      return { status: 204, headers: {}, body: '' }
    }
    throw new Error(`unexpected Jira transition request ${request.method} ${path}`)
  })
  const adapter = jiraAdapter(transport, 3, { in_progress: 'In Progress', done: '41' })
  assert.equal(adapter.statusMapping('in_progress'), 'transition')
  assert.equal(adapter.statusMapping('done'), 'transition')
  assert.equal(adapter.statusMapping('blocked'), 'none')
  assert.equal(adapter.statusMapping('failed'), 'none')

  assert.equal(
    (await adapter.mutate('PROJ-12', { kind: 'transition', status: 'in_progress' })).status,
    204,
  )
  assert.equal(
    (await adapter.mutate('PROJ-12', { kind: 'transition', status: 'done' })).status,
    204,
  )
  assert.deepEqual(applied, ['21', '41'])

  const before = transport.requests.length
  const unmapped = await adapter.mutate('PROJ-12', { kind: 'transition', status: 'blocked' })
  assert.equal(unmapped.skipped, true)
  assert.equal(transport.requests.length, before)

  await assert.rejects(
    adapter.mutate('PROJ-12', {
      kind: 'update-issue',
      fields: { summary: 'Overwrite the tracker summary' },
    } as unknown as TrackerMutation),
    (error: unknown) => {
      assert.ok(error instanceof TrackerSyncError)
      assert.equal(error.code, 'business_field_write_refused')
      return true
    },
  )
  assert.equal(transport.requests.length, before)
})

test('Jira v3 uses an ADF comment body and v2 uses plain text', async () => {
  const marker = '<!-- guanxi:transition:wg2-a:in_progress:1 -->'
  const text = `Guanxi item \`wg2-a\` is now **in_progress**.\n\n${marker}`

  const v3Transport = new ScriptedTransport(() => json(200, fixture('jira-comment-created-v3')))
  const v3 = await jiraAdapter(v3Transport, 3).mutate('PROJ-12', {
    kind: 'comment', body: text, marker,
  })
  assert.equal(v3.commentId, '20001')
  assert.equal(pathOf(v3Transport.requests[0]!), '/rest/api/3/issue/PROJ-12/comment')
  const v3Payload = JSON.parse(v3Transport.requests[0]!.body ?? '{}') as {
    body: { type: string; version: number; content: unknown[] }
  }
  assert.equal(v3Payload.body.type, 'doc')
  assert.equal(v3Payload.body.version, 1)
  assert.ok(v3Payload.body.content.length > 0)
  assert.match(adfToText(v3Payload.body), /guanxi:transition:wg2-a:in_progress:1/)

  const v2Transport = new ScriptedTransport(() => json(200, fixture('jira-comment-created-v2')))
  const v2 = await jiraAdapter(v2Transport, 2).mutate('PROJ-12', {
    kind: 'comment', body: text, marker,
  })
  assert.equal(v2.commentId, '20002')
  assert.equal(pathOf(v2Transport.requests[0]!), '/rest/api/2/issue/PROJ-12/comment')
  const v2Payload = JSON.parse(v2Transport.requests[0]!.body ?? '{}') as { body: unknown }
  assert.equal(typeof v2Payload.body, 'string')
  assert.equal(v2Payload.body, text)
})

test('Jira comment reads flatten ADF so idempotency markers survive', async () => {
  const v3Transport = new ScriptedTransport(() => json(200, fixture('jira-comments-marker-v3')))
  const v3 = await jiraAdapter(v3Transport, 3).listComments('PROJ-12')
  assert.equal(v3.length, 1)
  assert.equal(v3[0]!.id, '20003')
  assert.equal(v3[0]!.author, 'jira-cloud-bot')
  assert.match(v3[0]!.body, /<!-- guanxi:transition:wg2-a:in_progress:1 -->/)
  assert.equal(
    pathOf(v3Transport.requests[0]!),
    '/rest/api/3/issue/PROJ-12/comment',
  )

  const v2Transport = new ScriptedTransport(() => json(200, {
    startAt: 0,
    maxResults: 100,
    total: 1,
    comments: [{
      id: '20004',
      author: { name: 'jira-dc-bot' },
      body: 'plain marker <!-- guanxi:transition:wg2-a:done:2 -->',
    }],
  }))
  const v2 = await jiraAdapter(v2Transport, 2).listComments('PROJ-12')
  assert.equal(v2[0]!.author, 'jira-dc-bot')
  assert.match(v2[0]!.body, /guanxi:transition:wg2-a:done:2/)

  const emptyV3 = new ScriptedTransport(() => json(200, fixture('jira-comments-empty-v3')))
  assert.deepEqual(await jiraAdapter(emptyV3, 3).listComments('PROJ-12'), [])
  const emptyV2 = new ScriptedTransport(() => json(200, fixture('jira-comments-empty-v2')))
  assert.deepEqual(await jiraAdapter(emptyV2, 2).listComments('PROJ-12'), [])
})

test('planted credentials stay in the Authorization header only', async () => {
  const token = 'ghp_WG2A_planted_token_123456789'
  const transport = new ScriptedTransport(request => {
    if (pathOf(request).endsWith('/comments')) {
      return json(500, { message: 'upstream failed' })
    }
    if (request.method === 'GET') {
      return json(200, fixture('github-issue-initial'))
    }
    return json(400, { message: 'rejected' })
  })
  const adapter = new GitHubAdapter({
    http: request => transport.request(request),
    authorize: headers => {
      headers.Authorization = `Bearer ${token}`
    },
    credential: 'secret://vault/github/planted',
  })

  const read = await adapter.read('example-org/example-repo#7')
  assert.equal(JSON.stringify(read).includes(token), false)
  const retryable = await adapter.mutate('example-org/example-repo#7', {
    kind: 'comment',
    body: 'status\n<!-- guanxi:transition:wg2-a:in_progress:1 -->',
    marker: '<!-- guanxi:transition:wg2-a:in_progress:1 -->',
  })
  assert.equal(retryable.retryable, true)
  assert.equal(JSON.stringify(retryable).includes(token), false)

  const failing = new ScriptedTransport(() => json(200, '{'))
  await assert.rejects(
    new GitHubAdapter({
      http: request => failing.request(request),
      authorize: headers => {
        headers.Authorization = `Bearer ${token}`
      },
      credential: 'secret://vault/github/planted',
    }).read('example-org/example-repo#7'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(String(error).includes(token), false)
      assert.equal((error.stack ?? '').includes(token), false)
      return true
    },
  )

  const throwing = new ScriptedTransport(() => {
    throw new Error(`socket error carrying ${token}`)
  })
  await assert.rejects(
    new GitHubAdapter({
      http: request => throwing.request(request),
      authorize: headers => {
        headers.Authorization = `Bearer ${token}`
      },
      credential: 'secret://vault/github/planted',
    }).read('example-org/example-repo#7'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(String(error).includes(token), false)
      assert.equal((error.stack ?? '').includes(token), false)
      return true
    },
  )

  await assert.rejects(
    new GitHubAdapter({
      http: request => transport.request(request),
      authorize: () => {
        throw new Error(`credential resolution failed for ${token}`)
      },
      credential: 'secret://vault/github/planted',
    }).read('example-org/example-repo#7'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(String(error).includes(token), false)
      assert.equal((error.stack ?? '').includes(token), false)
      return true
    },
  )

  const all = [...transport.requests, ...failing.requests, ...throwing.requests]
  for (const request of all) {
    assert.equal(request.url.includes(token), false)
    assert.equal((request.body ?? '').includes(token), false)
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === 'authorization') {
        assert.equal(value, `Bearer ${token}`)
      } else {
        assert.equal(value.includes(token), false)
      }
    }
  }
})
