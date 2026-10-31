import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createExternalOpener } from '../../src/external-open.ts'

function setup() {
  const clock = { now: 1_000_000 }
  const opened: string[] = []
  const opener = createExternalOpener({ open: (url) => void opened.push(url), now: () => clock.now })
  return { clock, opened, opener }
}

describe('createExternalOpener', () => {
  it('opens a link right after real user input', () => {
    const { opener, opened } = setup()
    opener.noteUserInput()
    assert.equal(opener.request('https://example.com/a'), 'opened')
    assert.deepEqual(opened, ['https://example.com/a'])
  })

  it('one gesture opens one link: a script cannot reuse a click', () => {
    const { opener, opened } = setup()
    opener.noteUserInput()
    assert.equal(opener.request('https://example.com/first'), 'opened')
    assert.equal(opener.request('https://example.com/second'), 'no_activation')
    assert.deepEqual(opened, ['https://example.com/first'])
  })

  it('never opens for a script with no recent user input', () => {
    const { opener, opened, clock } = setup()
    assert.equal(opener.request('https://example.com/scripted'), 'no_activation')
    opener.noteUserInput()
    clock.now += 2_001
    assert.equal(opener.request('https://example.com/stale'), 'no_activation')
    assert.deepEqual(opened, [])
  })

  it('drops unsupported schemes even with user input', () => {
    const { opener, opened } = setup()
    opener.noteUserInput()
    for (const url of ['file:///etc/hosts', 'javascript:1', 'smb://h/s']) assert.equal(opener.request(url), 'unsupported')
    assert.deepEqual(opened, [])
  })

  it('rate-limits a flood: three per ten seconds, then again once the window passes', () => {
    const { opener, opened, clock } = setup()
    for (let i = 0; i < 3; i++) {
      opener.noteUserInput()
      assert.equal(opener.request(`https://example.com/${i}`), 'opened')
    }
    opener.noteUserInput()
    assert.equal(opener.request('https://example.com/4'), 'rate_limited')
    assert.equal(opened.length, 3)
    clock.now += 10_001
    opener.noteUserInput()
    assert.equal(opener.request('https://example.com/5'), 'opened')
  })
})
