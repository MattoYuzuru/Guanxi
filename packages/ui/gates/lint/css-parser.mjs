// A source-preserving ESLint adapter: PostCSS validates CSS in no-literal-css.
// Keeping the original text/ranges lets native ESLint bulk suppressions cover CSS too.
export default {
  meta: { name: 'guanxi-css', version: '1.0.0' },
  parseForESLint(text) {
    const lines = text.split('\n')
    return { ast: { type: 'Program', sourceType: 'module', body: [], tokens: [], comments: [], range: [0, text.length], loc: { start: { line: 1, column: 0 }, end: { line: lines.length, column: lines.at(-1).length } } } }
  },
}
