/** Parses one JSON value a model returned. Real chat models often wrap a JSON answer in a single Markdown code fence
 * (```json … ```) even when asked for raw JSON; that one wrapper is removed. Nothing else is repaired: unquoted keys,
 * trailing commas, prose around the value or several fences still fail, exactly like `JSON.parse`. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/.exec(trimmed)
  return JSON.parse(fenced ? fenced[1]! : trimmed)
}
