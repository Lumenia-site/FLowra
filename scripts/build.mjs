import { build as bundle } from 'esbuild'
import { build as viteBuild } from 'vite'
import { cp, mkdir } from 'node:fs/promises'

export async function buildMain() {
  await bundle({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true })
  await bundle({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] })
  await bundle({ entryPoints: ['src/main/worker.ts'], outfile: 'dist/main/worker.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] })
  await mkdir('resources/javascript', { recursive: true })
  await bundle({ entryPoints: ['src/exporter/javascript/entry.ts'], outfile: 'resources/javascript/runtime.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22' })
  await cp('src/bot', 'resources/javascript/source/src/bot', { recursive: true })
  await cp('src/shared', 'resources/javascript/source/src/shared', { recursive: true })
  await cp('src/exporter/javascript', 'resources/javascript/source/src/exporter/javascript', { recursive: true })
  await cp('src/exporter/python', 'resources/python', { recursive: true, filter: path => !path.includes('__pycache__') })
  await cp('LICENSE', 'resources/LICENSE')
  await cp('src/assets/icon.ico', 'dist/icon.ico')
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/build.mjs')) {
  await buildMain()
  await viteBuild()
}
