export default {
  plugins: ['./packages/ui/gates/lint/stylelint-plugin.mjs'],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/generated/**', '**/gates/**', 'packages/ui/tokens/**', 'packages/ui/fonts/**', 'packages/ui/brand/**'],
  rules: { 'guanxi/no-literal-css': true },
}
