import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const directory = fileURLToPath(new URL('.', import.meta.url))
await mkdir(`${directory}png`, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const variants = [
    ['logo.svg', 'logo-512.png', 512],
    ['logo.svg', 'logo-1024.png', 1024],
    ['logo-inverse.svg', 'logo-inverse-512.png', 512],
    ...[16, 32].map(size => ['favicon.svg', `favicon-${size}.png`, size]),
    ...[48, 64, 128, 180, 192, 256, 512, 1024].map(size => ['app-icon.svg', `icon-${size}.png`, size]),
  ]
  for (const [source, destination, size] of variants) {
    const content = await readFile(`${directory}${source}`, 'utf8')
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${content}`)
    await page.screenshot({ path: `${directory}png/${destination}`, omitBackground: true })
  }
  await page.setViewportSize({ width: 1280, height: 930 })
  await page.goto(pathToFileURL(`${directory}preview.html`).href)
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
  await page.screenshot({ path: `${directory}preview.png`, fullPage: true })
  console.log(`Rendered ${variants.length} PNG assets and preview.png`)
} finally {
  await browser.close()
}
