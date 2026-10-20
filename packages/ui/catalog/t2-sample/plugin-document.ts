/**
 * A sample untrusted (T2) plugin view, as an MCP Apps View would ship it: static HTML whose
 * styles use only MCP Apps host variables. It runs in a sandboxed iframe with an opaque
 * origin and learns the theme only through `ui/initialize` and
 * `ui/notifications/host-context-changed`. This document never changes when the theme does.
 */
export const T2_PLUGIN_DOCUMENT = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body {
    background: var(--color-background-primary, Canvas);
    color: var(--color-text-primary, CanvasText);
    font-family: var(--font-sans, system-ui);
    font-size: var(--font-text-md-size, 13px);
  }
  .card {
    margin: 12px;
    padding: 12px;
    border: var(--border-width-regular, 1px) solid var(--color-border-secondary, GrayText);
    border-radius: var(--border-radius-md, 12px);
    background: var(--color-background-secondary, Canvas);
    box-shadow: var(--shadow-sm, none);
  }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .swatch { width: 24px; height: 24px; border-radius: var(--border-radius-xs, 4px); }
  .info { background: var(--color-background-info); border: 1px solid var(--color-border-info); }
  .success { background: var(--color-background-success); border: 1px solid var(--color-border-success); }
  .warning { background: var(--color-background-warning); border: 1px solid var(--color-border-warning); }
  .danger { background: var(--color-background-danger); border: 1px solid var(--color-border-danger); }
  .theme { font-family: var(--font-mono, monospace); color: var(--color-text-secondary, GrayText); }
</style>
</head>
<body>
<div class="card" data-plugin-card>
  <div class="row">
    <span class="swatch info"></span><span class="swatch success"></span>
    <span class="swatch warning"></span><span class="swatch danger"></span>
    <code class="theme" data-plugin-theme></code>
  </div>
</div>
<script>
  var nextId = 1;
  function apply(context) {
    if (!context) return;
    var variables = (context.styles && context.styles.variables) || {};
    for (var name in variables) {
      if (name.indexOf('--') === 0) document.documentElement.style.setProperty(name, variables[name]);
    }
    if (context.theme) {
      document.documentElement.style.colorScheme = context.theme;
      document.querySelector('[data-plugin-theme]').textContent = context.theme;
    }
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === 1 && message.result) {
      apply(message.result.hostContext);
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
    } else if (message.method === 'ui/notifications/host-context-changed') {
      apply(message.params);
    }
  });
  window.parent.postMessage({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'ui/initialize',
    params: { protocolVersion: '2026-01-26', appCapabilities: {}, appInfo: { name: 'guanxi-t2-sample', version: '0.1.0' } }
  }, '*');
</script>
</body>
</html>`
