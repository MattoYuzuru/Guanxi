import { Fragment, type ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
      <code key={index}>{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  )
}

/** Paragraphs, bullet lists and inline code: all the docs.md sections use. */
export function DocMarkdown({ source }: { source: string }) {
  const blocks = source.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n')
        if (lines.every((line) => /^- |^ {2}/.test(line))) {
          const items: string[] = []
          for (const line of lines) {
            if (line.startsWith('- ')) items.push(line.slice(2))
            else items[items.length - 1] += ` ${line.trim()}`
          }
          return (
            <ul key={index}>
              {items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </ul>
          )
        }
        return <p key={index}>{inline(lines.join(' '))}</p>
      })}
    </>
  )
}
