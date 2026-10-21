import { mcpAppsVariables } from '../../generated/mcp-apps-variables.ts'

/**
 * Host style variables sent to MCP Apps views (HostContext.styles): the names DS1-a's token
 * build generates for that vocabulary (packages/ui/generated/mcp-apps-variables.ts).
 */
export const MCP_APPS_VARIABLES = Object.keys(mcpAppsVariables.light)

/** Reads the resolved value of every MCP Apps variable from a themed host element. */
export function readHostVariables(element: Element): Record<string, string> {
  const style = getComputedStyle(element)
  const variables: Record<string, string> = {}
  for (const name of MCP_APPS_VARIABLES) {
    const value = style.getPropertyValue(name).trim()
    if (value !== '') variables[name] = value
  }
  return variables
}
