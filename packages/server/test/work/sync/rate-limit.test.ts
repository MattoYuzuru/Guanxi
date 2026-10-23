import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GITHUB_CONTENT_PER_HOUR,
  GITHUB_CONTENT_PER_MINUTE,
  GITHUB_HOUR_WINDOW_MS,
  GITHUB_MINUTE_WINDOW_MS,
  JIRA_WRITES_PER_ISSUE,
  JIRA_WRITE_WINDOW_MS,
  RETRY_BACKOFF_MAX_MS,
  SECONDARY_LIMIT_BACKOFF_MAX_MS,
  RateLimitGovernor,
  TokenBucket,
  backoffMs,
  parseRetryAfter,
} from '../../../src/work/sync/rate-limit.ts'

const START = 1_700_000_000_000

function governor(overrides: ConstructorParameters<typeof RateLimitGovernor>[0] = {}) {
  return new RateLimitGovernor({ now: () => START, ...overrides })
}

test('GitHub content budgets are 80/min and 500/h with exact refill times', () => {
  assert.equal(GITHUB_CONTENT_PER_MINUTE, 80)
  assert.equal(GITHUB_CONTENT_PER_HOUR, 500)

  const perMinute = governor()
  for (let index = 0; index < 80; index++) {
    assert.equal(
      perMinute.checkWrite({
        tracker: 'github', key: 'example-org/example-repo#7',
        contentCreation: true, now: START,
      }).allowed,
      true,
    )
  }
  const denied = perMinute.checkWrite({
    tracker: 'github', key: 'example-org/example-repo#7',
    contentCreation: true, now: START,
  })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'content_budget')
  assert.equal(denied.nextAllowedAt, START + GITHUB_MINUTE_WINDOW_MS / 80)
  assert.equal(denied.nextAllowedAt, START + 750)
  assert.equal(
    perMinute.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: denied.nextAllowedAt,
    }).allowed,
    true,
  )

  // Isolate the hourly bucket: a very wide minute budget still stops at 500 writes.
  const perHour = governor({ github: { contentPerMinute: 100_000, contentPerHour: 500 } })
  for (let index = 0; index < 500; index++) {
    assert.equal(
      perHour.checkWrite({
        tracker: 'github', key: 'example-org/example-repo#7',
        contentCreation: true, now: START,
      }).allowed,
      true,
    )
  }
  const hourly = perHour.checkWrite({
    tracker: 'github', key: 'example-org/example-repo#7',
    contentCreation: true, now: START,
  })
  assert.equal(hourly.allowed, false)
  assert.equal(hourly.nextAllowedAt, START + GITHUB_HOUR_WINDOW_MS / GITHUB_CONTENT_PER_HOUR)
  assert.equal(hourly.nextAllowedAt, START + 7_200)

  const bucket = new TokenBucket(500, GITHUB_HOUR_WINDOW_MS)
  for (let index = 0; index < 500; index++) bucket.take(START)
  assert.equal(bucket.nextAllowedAt(START), START + 7_200)
})

test('retry-after seconds and HTTP dates defer at the exact millisecond', () => {
  const retry = governor()
  const observation = retry.observeWrite({
    tracker: 'github', key: 'example-org/example-repo#7', status: 429,
    headers: { 'Retry-After': '3' }, contentCreation: true, retryable: true, now: START,
  })
  assert.equal(observation.retry, true)
  assert.equal(observation.reason, 'retry_after')
  assert.equal(observation.nextAllowedAt, START + 3_000)
  assert.equal(
    retry.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: START + 2_999,
    }).allowed,
    false,
  )
  assert.equal(
    retry.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: START + 3_000,
    }).allowed,
    true,
  )

  const date = new Date(START + 4_000).toUTCString()
  assert.equal(parseRetryAfter(date, START), 4_000)
  assert.equal(parseRetryAfter('1.5', START), 1_500)
  assert.equal(parseRetryAfter('not-a-date', START), null)
})

test('GitHub reset headers defer writes until the server reset time', () => {
  const limits = governor()
  const observation = limits.observeWrite({
    tracker: 'github', key: 'example-org/example-repo#7', status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(START / 1_000 + 5),
    },
    contentCreation: true, retryable: true, now: START,
  })
  assert.equal(observation.retry, true)
  assert.equal(observation.nextAllowedAt, START + 5_000)
  const denied = limits.checkWrite({
    tracker: 'github', key: 'example-org/example-repo#7',
    contentCreation: true, now: START + 4_999,
  })
  assert.equal(denied.allowed, false)
  assert.equal(denied.nextAllowedAt, START + 5_000)
  assert.equal(
    limits.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: START + 5_000,
    }).allowed,
    true,
  )
})

test('secondary-limit 403s use bounded exponential backoff', () => {
  const limits = governor()
  let now = START
  const delays: number[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const observation = limits.observeWrite({
      tracker: 'github', key: 'example-org/example-repo#7', status: 403,
      headers: {}, contentCreation: true, retryable: true, now,
    })
    assert.equal(observation.retry, true)
    assert.equal(observation.reason, 'secondary_limit')
    delays.push(observation.nextAllowedAt - now)
    now = observation.nextAllowedAt
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  assert.equal(delays.at(-1), SECONDARY_LIMIT_BACKOFF_MAX_MS)
})

test('Jira permits 20 writes per issue per two seconds and isolates issues', () => {
  assert.equal(JIRA_WRITES_PER_ISSUE, 20)
  assert.equal(JIRA_WRITE_WINDOW_MS, 2_000)
  const limits = governor()
  for (let index = 0; index < 20; index++) {
    assert.equal(
      limits.checkWrite({
        tracker: 'jira', key: 'PROJ-12', contentCreation: true, now: START,
      }).allowed,
      true,
    )
  }
  const denied = limits.checkWrite({
    tracker: 'jira', key: 'PROJ-12', contentCreation: true, now: START,
  })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'jira_burst')
  assert.equal(denied.nextAllowedAt, START + JIRA_WRITE_WINDOW_MS / JIRA_WRITES_PER_ISSUE)
  assert.equal(denied.nextAllowedAt, START + 100)

  assert.equal(
    limits.checkWrite({ tracker: 'jira', key: 'PROJ-13', contentCreation: true, now: START }).allowed,
    true,
  )
  assert.equal(
    limits.checkWrite({
      tracker: 'jira', key: 'PROJ-12', contentCreation: true, now: START + 100,
    }).allowed,
    true,
  )
})

test('5xx responses retry with bounded exponential backoff', () => {
  const limits = governor()
  let now = START
  const delays: number[] = []
  for (let attempt = 0; attempt < 8; attempt++) {
    const observation = limits.observeWrite({
      tracker: 'github', key: 'example-org/example-repo#7', status: 503,
      headers: {}, contentCreation: true, retryable: true, now,
    })
    assert.equal(observation.retry, true)
    assert.equal(observation.reason, 'server_backoff')
    delays.push(observation.nextAllowedAt - now)
    now = observation.nextAllowedAt
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
  assert.equal(delays.at(-1), RETRY_BACKOFF_MAX_MS)
  assert.equal(backoffMs(4, 1_000, 60_000), 8_000)
  assert.equal(backoffMs(40, 1_000, 60_000), 60_000)

  const withHeader = limits.observeWrite({
    tracker: 'jira', key: 'PROJ-12', status: 503,
    headers: { 'retry-after': '7' }, contentCreation: true, retryable: true, now: START,
  })
  assert.equal(withHeader.nextAllowedAt, START + 7_000)
})

test('a denied write consumes no budget and a non-retryable failure schedules nothing', () => {
  const limits = governor()
  for (let index = 0; index < 80; index++) {
    limits.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: START,
    })
  }
  const denied = limits.checkWrite({
    tracker: 'github', key: 'example-org/example-repo#7',
    contentCreation: true, now: START,
  })
  assert.equal(denied.allowed, false)
  assert.equal(
    limits.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: denied.nextAllowedAt,
    }).allowed,
    true,
  )

  const rejected = limits.observeWrite({
    tracker: 'github', key: 'example-org/example-repo#7', status: 422,
    headers: {}, contentCreation: true, retryable: false, now: START,
  })
  assert.equal(rejected.retry, false)
  assert.equal(limits.nextAllowedAt({
    tracker: 'github', key: 'example-org/example-repo#7',
    contentCreation: false, now: START,
  }), START)
})

test('label writes skip the content-creation budget but keep server backoff', () => {
  const limits = governor()
  for (let index = 0; index < 80; index++) {
    limits.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: true, now: START,
    })
  }
  assert.equal(
    limits.checkWrite({
      tracker: 'github', key: 'example-org/example-repo#7',
      contentCreation: false, now: START,
    }).allowed,
    true,
  )
  limits.observeWrite({
    tracker: 'github', key: 'example-org/example-repo#7', status: 429,
    headers: { 'retry-after': '2' }, contentCreation: false, retryable: true, now: START,
  })
  const denied = limits.checkWrite({
    tracker: 'github', key: 'example-org/example-repo#7',
    contentCreation: false, now: START + 1_000,
  })
  assert.equal(denied.allowed, false)
  assert.equal(denied.nextAllowedAt, START + 2_000)
})
