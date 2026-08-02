/**
 * Тесты распознавания вызовов инструментов.
 *
 * Случаи `content_json` — не гипотетические: это дословные ответы qwen2.5-coder:7b
 * на Ollama 0.32, снятые при проверке осуществимости агентного режима.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseToolCalls } from '../src/agent/tool-parser.ts'

const KNOWN = { knownTools: new Set(['read_file', 'write_file', 'list_dir', 'grep']) }

describe('нативный формат', () => {
  it('разбирает структурное поле tool_calls', () => {
    const result = parseToolCalls(
      [{ function: { name: 'read_file', arguments: { path: 'src/index.ts' } } }],
      '',
      KNOWN,
    )

    assert.equal(result.calls.length, 1)
    assert.deepEqual(result.calls[0], {
      name: 'read_file',
      arguments: { path: 'src/index.ts' },
      parsedFrom: 'native',
    })
  })

  it('принимает аргументы, присланные строкой с JSON', () => {
    const result = parseToolCalls(
      [{ function: { name: 'grep', arguments: '{"pattern":"TODO"}' } }],
      '',
      KNOWN,
    )
    assert.deepEqual(result.calls[0]?.arguments, { pattern: 'TODO' })
  })

  it('нативный вызов имеет приоритет над текстом', () => {
    const result = parseToolCalls(
      [{ function: { name: 'list_dir', arguments: { path: '.' } } }],
      '{"name": "read_file", "arguments": {"path": "other.txt"}}',
      KNOWN,
    )
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.parsedFrom, 'native')
  })
})

describe('запасной разбор из content', () => {
  it('дословный ответ qwen2.5-coder:7b без обёрток', () => {
    // Ровно эта строка пришла в замере: поле tool_calls было null.
    const content = '{"name": "read_file", "arguments": {"path": "/tmp/demo/readme.md"}}'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.name, 'read_file')
    assert.equal(result.calls[0]?.parsedFrom, 'content_json')
    assert.deepEqual(result.calls[0]?.arguments, { path: '/tmp/demo/readme.md' })
    assert.equal(result.cleanedContent, '')
  })

  it('многострочный ответ qwen2.5-coder:7b', () => {
    const content = '{\n  "name": "list_dir",\n  "arguments": {\n    "path": "/tmp/demo"\n  }\n}'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls[0]?.name, 'list_dir')
    assert.deepEqual(result.calls[0]?.arguments, { path: '/tmp/demo' })
  })

  it('обёртка <tool_call> из шаблона Qwen', () => {
    const content = '<tool_call>\n{"name": "grep", "arguments": {"pattern": "TODO"}}\n</tool_call>'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls[0]?.name, 'grep')
    assert.equal(result.cleanedContent, '')
  })

  it('вызов в ограждённом блоке кода', () => {
    const content = 'Сейчас прочитаю файл.\n```json\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 1)
    assert.match(result.cleanedContent, /Сейчас прочитаю файл/)
    assert.doesNotMatch(result.cleanedContent, /read_file/)
  })

  it('ключ parameters вместо arguments', () => {
    const result = parseToolCalls(null, '{"name":"read_file","parameters":{"path":"x.md"}}', KNOWN)
    assert.deepEqual(result.calls[0]?.arguments, { path: 'x.md' })
  })

  it('обёртка {"tool_call": {...}}', () => {
    const result = parseToolCalls(
      null,
      '{"tool_call": {"name": "list_dir", "arguments": {"path": "src"}}}',
      KNOWN,
    )
    assert.equal(result.calls[0]?.name, 'list_dir')
  })

  it('несколько вызовов подряд', () => {
    const content =
      '{"name":"read_file","arguments":{"path":"a.ts"}}\n{"name":"read_file","arguments":{"path":"b.ts"}}'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 2)
    assert.equal(result.calls[1]?.arguments['path'], 'b.ts')
  })

  it('вложенные объекты в аргументах не ломают разбор', () => {
    const content = '{"name":"write_file","arguments":{"path":"a.json","meta":{"deep":{"x":1}}}}'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 1)
    assert.deepEqual(result.calls[0]?.arguments['meta'], { deep: { x: 1 } })
  })

  it('фигурные скобки внутри строкового значения не сбивают счётчик', () => {
    const content = '{"name":"grep","arguments":{"pattern":"function() { return {}; }"}}'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.arguments['pattern'], 'function() { return {}; }')
  })

  it('инструмент без аргументов', () => {
    const result = parseToolCalls(null, '{"name":"list_dir"}', KNOWN)
    assert.deepEqual(result.calls[0]?.arguments, {})
  })
})

describe('ложные срабатывания', () => {
  it('не считает вызовом JSON с неизвестным именем', () => {
    // Модель объясняет формат, а не просит инструмент.
    const content = 'Формат такой: {"name": "some_other_tool", "arguments": {"a": 1}}'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 0)
    assert.equal(result.cleanedContent, content)
  })

  it('не трогает обычный JSON в ответе', () => {
    const content = 'Вот конфиг:\n```json\n{"port": 3000, "host": "localhost"}\n```'
    const result = parseToolCalls(null, content, KNOWN)

    assert.equal(result.calls.length, 0)
    assert.equal(result.cleanedContent, content)
  })

  it('не разбирает текст, когда реестр инструментов пуст', () => {
    const content = '{"name":"read_file","arguments":{"path":"a.ts"}}'
    const result = parseToolCalls(null, content, { knownTools: new Set() })

    assert.equal(result.calls.length, 0)
    assert.equal(result.cleanedContent, content)
  })

  it('битый JSON не роняет разбор', () => {
    const result = parseToolCalls(null, '{"name": "read_file", "arguments": {', KNOWN)
    assert.equal(result.calls.length, 0)
  })

  it('пустой ответ', () => {
    const result = parseToolCalls(null, '', KNOWN)
    assert.equal(result.calls.length, 0)
    assert.equal(result.cleanedContent, '')
  })
})
