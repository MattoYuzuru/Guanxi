import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PRODUCT_NAME } from '../../../packages/web/src/lib/brand.ts'

const directory = fileURLToPath(new URL('.', import.meta.url))
await mkdir(directory, { recursive: true })

// Hand-drawn Bezier contours, reconstructed from the selected concept 05.
// Coordinates describe the mark itself; its counter is open, not a white overlay.
const body = `M199 113H162Q157 113 153 108L96 43
C86 32 78 27 65 27C49 27 37 36 37 51
C37 65 49 74 65 73C77 73 85 65 93 56
Q98 50 102 55L118 73C121 119 94 153 57 153
C35 153 16 147 3 136Q-2 133 2 129L15 116
Q19 112 24 116C33 122 43 126 56 125
C74 124 85 111 88 93C77 98 69 101 57 100
C27 100 4 81 4 52C4 21 29 0 65 0
C89 0 109 9 126 28L200 107Q204 113 199 113Z`
const arm = `M146 23L162 5Q166 0 172 0H198
Q204 0 200 5L163 45Q160 49 157 45L144 31
Q141 28 146 23Z`
// More air between the detached arm and the diagonal at 16 and 32 pixels.
const smallArm = `M153 18L166 3Q169 0 174 0H198
Q204 0 200 5L168 40Q165 43 162 40L151 28
Q147 24 153 18Z`

const ink = '#182322'
const ivory = '#F4F2E9'
const paths = (compact = false) => `<path d="${body.replace(/\n/g, '')}"/><path d="${(compact ? smallArm : arm).replace(/\n/g, '')}"/>`
function svg({ name, foreground, background, compact = false }) {
  const transform = compact ? 'translate(47 97) scale(2.08)' : 'translate(48 100) scale(2.06)'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-labelledby="title"><title id="title">${PRODUCT_NAME} — ${name}</title>${background ? `<rect width="512" height="512" rx="112" fill="${background}"/>` : ''}<g fill="${foreground}" transform="${transform}">${paths(compact)}</g></svg>\n`
}
const files = {
  'logo.svg': svg({ name: 'gx symbol', foreground: ink }),
  'logo-inverse.svg': svg({ name: 'gx symbol, inverse', foreground: ivory }),
  'logo-mono.svg': svg({ name: 'gx symbol, monochrome', foreground: 'currentColor' }),
  'app-icon.svg': svg({ name: 'application icon', foreground: ivory, background: ink }),
  'favicon.svg': svg({ name: 'small application icon', foreground: ivory, background: ink, compact: true }),
}
for (const [name, content] of Object.entries(files)) await writeFile(`${directory}${name}`, content)

await writeFile(`${directory}preview.html`, `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${PRODUCT_NAME} — gx identity</title>
<style>
*{box-sizing:border-box}body{margin:0;background:${ivory};color:${ink};font-family:Arial,Helvetica,sans-serif}main{width:1280px;padding:48px 64px 38px;margin:auto}header{display:flex;align-items:baseline;justify-content:space-between;padding-bottom:30px;border-bottom:1px solid #18232225}h1{margin:0;font-size:34px;letter-spacing:-1.2px}header p{font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:0}.pair{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #18232225}.hero{height:386px;display:flex;align-items:center;justify-content:center;flex-direction:column;position:relative}.hero:first-child{border-right:1px solid #18232225}.hero.dark{background:${ink};color:${ivory}}.hero img{width:300px;height:260px;object-fit:contain}.wordmark{font-size:41px;letter-spacing:-2px;font-weight:600;line-height:1;margin-top:-18px}.caption{position:absolute;top:24px;left:24px;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;opacity:.6}.bottom{display:grid;grid-template-columns:1fr 1.7fr;padding:32px 0 26px;gap:40px;border-bottom:1px solid #18232225}h2{font-weight:400;letter-spacing:1.7px;text-transform:uppercase;font-size:11px;margin:0 0 24px}.apps{display:flex;gap:24px;align-items:flex-end}.apps figure,.sizes figure{margin:0;text-align:center}.apps img{display:block}.apps figcaption,.sizes figcaption{margin-top:13px;font-size:11px;opacity:.55}.sizes{display:flex;gap:28px;align-items:flex-end;height:143px;padding-bottom:3px}.sizes img{display:block}.sizes .small img{image-rendering:pixelated}.size-note{font-size:11px;opacity:.55;margin:19px 0 0;line-height:1.5}footer{display:flex;justify-content:space-between;font-size:11px;padding-top:23px;opacity:.55;letter-spacing:.3px}
</style><main><header><h1>${PRODUCT_NAME}</h1><p>gx / Selected direction 05 / v1</p></header><section class="pair"><div class="hero"><span class="caption">Light</span><img src="logo.svg" alt="gx symbol"><div class="wordmark">${PRODUCT_NAME}</div></div><div class="hero dark"><span class="caption">Dark</span><img src="logo-inverse.svg" alt="gx symbol in ivory"><div class="wordmark">${PRODUCT_NAME}</div></div></section><section class="bottom"><div><h2>Application icon</h2><div class="apps"><figure><img src="app-icon.svg" width="128" height="128" alt="Application icon"><figcaption>128 px</figcaption></figure><figure><img src="app-icon.svg" width="64" height="64" alt="Application icon"><figcaption>64 px</figcaption></figure></div></div><div><h2>Small-size specimens</h2><div class="sizes"><figure><img src="png/favicon-16.png" width="16" height="16" alt="16 pixel icon"><figcaption>16 px</figcaption></figure><figure><img src="png/favicon-32.png" width="32" height="32" alt="32 pixel icon"><figcaption>32 px</figcaption></figure><figure><img src="png/icon-48.png" width="48" height="48" alt="48 pixel icon"><figcaption>48 px</figcaption></figure><figure><img src="png/icon-64.png" width="64" height="64" alt="64 pixel icon"><figcaption>64 px</figcaption></figure><figure class="small"><img src="png/favicon-16.png" width="96" height="96" alt="16 pixel icon enlarged six times"><figcaption>16 px × 6</figcaption></figure></div><p class="size-note">16–32 px use a wider separation in the upper arm.<br>The wordmark is preview typography; the SVG files contain the symbol only.</p></div></section><footer><span>Ink ${ink} · Ivory ${ivory}</span><span>Hand-drawn vector contours · No embedded bitmap or fonts</span></footer></main></html>`)
console.log(`Built ${Object.keys(files).length} SVG assets and preview.html in ${directory}`)
