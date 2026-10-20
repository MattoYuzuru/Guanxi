/** Props of exported components, read with the TypeScript checker (manifest only). */
import { dirname, join, sep } from 'node:path'
import ts from 'typescript'
import type { ManifestProp } from '../manifest-types.ts'
import type { ComponentFolder } from './inventory.ts'

function program(uiRoot: string, roots: string[]): ts.Program {
  const configPath = join(uiRoot, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  return ts.createProgram({ rootNames: roots, options: { ...parsed.options, noEmit: true } })
}

export function readProps(uiRoot: string, folders: ComponentFolder[]): Map<string, Record<string, ManifestProp[]>> {
  const result = new Map<string, Record<string, ManifestProp[]>>()
  const roots = folders.filter((folder) => folder.hasImplementation).map((folder) => join(folder.dir, `${folder.id}.tsx`))
  if (roots.length === 0) return result
  const prog = program(uiRoot, roots)
  const checker = prog.getTypeChecker()
  const ownSources = join(uiRoot, 'src') + sep
  for (const folder of folders) {
    const file = prog.getSourceFile(join(folder.dir, `${folder.id}.tsx`))
    const symbol = file ? checker.getSymbolAtLocation(file) : undefined
    const byExport: Record<string, ManifestProp[]> = {}
    if (!file || !symbol) {
      result.set(folder.id, byExport)
      continue
    }
    for (const exported of checker.getExportsOfModule(symbol)) {
      if (!folder.valueExports.includes(exported.name) || !/^[A-Z]/.test(exported.name)) continue
      const type = checker.getTypeOfSymbolAtLocation(exported, file)
      const signature = type.getCallSignatures()[0]
      const parameter = signature?.getParameters()[0]
      if (!signature || !parameter) continue
      const propsType = checker.getTypeOfSymbolAtLocation(parameter, file)
      const props: ManifestProp[] = []
      for (const property of propsType.getProperties()) {
        const declaration = property.declarations?.[0]
        if (!declaration || !declaration.getSourceFile().fileName.startsWith(ownSources)) continue
        props.push({
          name: property.name,
          type: checker.typeToString(checker.getTypeOfSymbolAtLocation(property, file), undefined, ts.TypeFormatFlags.NoTruncation),
          required: (property.flags & ts.SymbolFlags.Optional) === 0,
          description: ts.displayPartsToString(property.getDocumentationComment(checker)),
        })
      }
      byExport[exported.name] = props.sort((a, b) => a.name.localeCompare(b.name))
    }
    result.set(folder.id, byExport)
  }
  return result
}
