import parser from '@typescript-eslint/parser'
import guanxi from './packages/ui/gates/lint/eslint-plugin.mjs'
import cssParser from './packages/ui/gates/lint/css-parser.mjs'

const source = ['packages/*/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}', 'plugins/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}', 'packages/plugins/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}']
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/generated/**', '**/test-results/**', '.lane-data/**', '.claude/**', '**/gates/catalog/fixtures/**'] },
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  { files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'], languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } } },
  {
    files: source,
    ignores: ['packages/ui/**', 'packages/server/**', 'packages/cli/**', 'packages/kernel/**', 'packages/contract/**'],
    plugins: { guanxi },
    rules: {
      'guanxi/import-boundaries': 'error',
      'guanxi/reuse-primitives': 'error',
      'guanxi/no-inline-colours': 'error',
      'guanxi/no-literal-styles': 'error',
      'guanxi/semantic-classes': 'error',
    },
  },
  {
    files: ['packages/*/src/**/*.css', 'plugins/**/*.css', 'packages/plugins/**/*.css'],
    languageOptions: { parser: cssParser },
    plugins: { guanxi },
    rules: { 'guanxi/no-literal-css': 'error' },
  },
  {
    files: ['packages/*/src/**/*.{svg,html}', 'plugins/**/*.{svg,html}', 'packages/plugins/**/*.{svg,html}'],
    languageOptions: { parser: cssParser },
    plugins: { guanxi },
    rules: { 'guanxi/svg-styles': 'error' },
  },
]
