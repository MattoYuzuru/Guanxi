import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Parser, Language, type Node } from 'web-tree-sitter'
import type { SymbolEntry } from './types.ts'

export const PARSER_VERSION = 'x1.1/web@0.25.10/ts@0.23.2/js,py,go@0.25.0/rust@0.24.0/java@0.23.5/c@0.24.1/cpp@0.23.4'
const require = createRequire(import.meta.url)
const languages = new Map<string, Language | null>()
let initialized: Promise<void> | undefined
const declarations = /^(function_declaration|function_definition|method_definition|method_declaration|class_declaration|class_definition|interface_declaration|type_alias_declaration|type_declaration|struct_item|enum_item|trait_item|impl_item|function_item|struct_specifier|class_specifier|enum_specifier|type_spec|lexical_declaration|variable_declaration)$/

export async function symbols(text: string, language: string, disabled: readonly string[] = [], directories: Record<string, string> = {}): Promise<{ entries: SymbolEntry[]; source: 'tree-sitter' | 'markdown' | 'file' }> {
  if (language === 'markdown') {
    const entries: SymbolEntry[] = []
    let fence: string | null = null
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue }
      if (fence) continue
      const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1]
      if (heading) entries.push({ name: heading, kind: 'heading', line: i + 1 })
      else if (i > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(line) && lines[i - 1]!.trim()) entries.push({ name: lines[i - 1]!.trim(), kind: 'heading', line: i })
    }
    return { entries, source: 'markdown' }
  }
  if (language === 'file' || disabled.includes(language)) return { entries: [], source: 'file' }
  try {
    initialized ??= Parser.init()
    await initialized
    if (!languages.has(language)) {
      const pkg = `tree-sitter-${language === 'tsx' ? 'typescript' : language}`
      const base = directories[language] ?? dirname(require.resolve(`${pkg}/package.json`))
      languages.set(language, await Language.load(join(base, `tree-sitter-${language}.wasm`)))
    }
    const grammar = languages.get(language)
    if (!grammar) return { entries: [], source: 'file' }
    const parser = new Parser()
    parser.setLanguage(grammar)
    const tree = parser.parse(text)
    try {
      const entries: SymbolEntry[] = []
      const stack: Node[] = tree ? [tree.rootNode] : []
      while (stack.length) {
        const node = stack.pop()!
        if (declarations.test(node.type)) {
          let name = node.childForFieldName('name') ?? node.childForFieldName('declarator')
          if (!name && ['lexical_declaration', 'variable_declaration'].includes(node.type)) name = node.namedChildren[0]?.childForFieldName('name') ?? null
          if (name) entries.push({ name: name.text, kind: node.type, line: node.startPosition.row + 1 })
        }
        stack.push(...node.namedChildren.filter((n): n is Node => n !== null).reverse())
      }
      return { entries, source: 'tree-sitter' }
    } finally { tree?.delete(); parser.delete() }
  } catch {
    // An absent/incompatible grammar never disables repository navigation.
    languages.set(language, null)
    return { entries: [], source: 'file' }
  }
}
