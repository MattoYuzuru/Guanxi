import { accessSync, constants, realpathSync } from 'node:fs'
import { delimiter, join, isAbsolute } from 'node:path'
import type { SandboxPolicy, sandboxCommand } from '../native-agent/sandbox.ts'
import { quote } from '../native-agent/sandbox.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { SymbolEntry } from './types.ts'
import { languageOf } from './snapshot.ts'

const specs: Record<string, [string, string[]]> = {
  typescript: ['typescript-language-server', ['--stdio']], tsx: ['typescript-language-server', ['--stdio']], javascript: ['typescript-language-server', ['--stdio']],
  python: ['pylsp', []], go: ['gopls', []], rust: ['rust-analyzer', []], java: ['jdtls', []], c: ['clangd', []], cpp: ['clangd', []],
}
/** Capture installed executables at node boot. No downloads, shell lookup, Serena
 * import or GPL dependency. Availability inside ExecutionOwner is rechecked by
 * execution; a host-only installation can be unavailable in a container. */
export function installedServers(path = process.env.PATH ?? ''): Record<string, [string, string[]]> {
  const found: Record<string, [string, string[]]> = {}
  for (const [language, [name, args]] of Object.entries(specs)) for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue
    try { const file = join(directory, name); accessSync(file, constants.X_OK); found[language] = [realpathSync(file), args]; break } catch { /* optional */ }
  }
  return found
}
const installed = installedServers()

/** Minimal stdio LSP client, executed wholly inside the existing OS sandbox.
 * It handles initialization, server requests, document symbols and shutdown.
 * The execution owner owns cancellation and the entire descendant lifetime. */
export const LSP_CLIENT = String.raw`
const {spawn}=require('node:child_process'), fs=require('node:fs'), {pathToFileURL}=require('node:url');
const config=JSON.parse(process.argv[1]);
const child=spawn(config.executable,config.args,{cwd:config.root,env:process.env,stdio:['pipe','pipe','ignore']});
let bytes=Buffer.alloc(0), settled=false;
const send=m=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));child.stdin.write('Content-Length: '+b.length+'\r\n\r\n');child.stdin.write(b)};
const finish=result=>{if(settled)return;settled=true;process.stdout.write(JSON.stringify(result));child.kill('SIGKILL');clearTimeout(timer)};
const timer=setTimeout(()=>finish(null),8000);
child.on('error',()=>finish(null));child.stdin.on('error',()=>finish(null));child.on('exit',()=>finish(null));
child.stdout.on('data',data=>{bytes=Buffer.concat([bytes,data]);if(bytes.length>2*1024*1024)return finish(null);
while(true){const header=bytes.indexOf('\r\n\r\n');if(header<0)return;const n=/Content-Length:\s*(\d+)/i.exec(bytes.subarray(0,header).toString())?.[1];if(!n)return finish(null);const length=Number(n);if(bytes.length<header+4+length)return;
let m;try{m=JSON.parse(bytes.subarray(header+4,header+4+length))}catch{return finish(null)}bytes=bytes.subarray(header+4+length);
if(m.method&&m.id!==undefined){send({id:m.id,result:null});continue}
if(m.id===1){if(m.error)return finish(null);send({method:'initialized',params:{}});const uri=pathToFileURL(config.path).href;
send({method:'textDocument/didOpen',params:{textDocument:{uri,languageId:config.language,version:1,text:fs.readFileSync(config.path,'utf8')}}});
send({id:2,method:'textDocument/documentSymbol',params:{textDocument:{uri}}});}
else if(m.id===2){if(m.error||!Array.isArray(m.result))return finish(null);const symbols=[];const walk=rows=>{for(const r of rows){if(typeof r.name==='string'){const line=(r.selectionRange??r.range??r.location?.range)?.start?.line; if(Number.isSafeInteger(line))symbols.push({name:r.name,kind:'lsp:'+r.kind,line:line+1})}if(Array.isArray(r.children))walk(r.children)}};walk(m.result);send({id:3,method:'shutdown',params:null});finish(symbols)}
}});
send({id:1,method:'initialize',params:{processId:process.pid,rootUri:pathToFileURL(config.root).href,capabilities:{textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},workspaceFolders:[{uri:pathToFileURL(config.root).href,name:'project'}]}});
`
export async function directSymbols(policy: SandboxPolicy, root: string, path: string, execute: typeof sandboxCommand, scrubber: EgressScrubber, signal?: AbortSignal, servers = installed): Promise<SymbolEntry[] | null> {
  const language = languageOf(path), server = servers[language]
  if (!server) return null
  const config = { root, path, language, executable: server[0], args: server[1] }
  try {
    // Read-only, no egress, irrespective of the native session's access mode.
    const result = await execute({ ...policy, mode: 'read-only', domains: [] }, `${quote(process.platform === 'darwin' ? '/usr/local/bin/node' : process.execPath)} -e ${quote(LSP_CLIENT)} ${quote(JSON.stringify(config))}`, signal, 10_000, false, scrubber)
    if (result.code !== 0 || result.truncated) return null
    const rows: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(rows) || !rows.every(r => typeof r?.name === 'string' && typeof r?.kind === 'string' && Number.isSafeInteger(r?.line) && r.line > 0)) return null
    return scrubber.scrub(rows) as SymbolEntry[]
  } catch { signal?.throwIfAborted(); return null }
}
