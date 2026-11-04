import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { zipSync } from 'fflate'

const files = {}
async function add(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue
    const filename = `${directory}/${entry.name}`
    if (entry.isDirectory()) await add(filename)
    else files[`Flowra-1.0.0/${filename}`] = await readFile(filename)
  }
}
for (const directory of ['src', 'scripts', 'tests']) await add(directory)
for (const filename of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.mjs', 'README.md', 'VERIFICATION.md', 'LICENSE', '.gitignore', '.env.example']) files[`Flowra-1.0.0/${filename}`] = await readFile(filename)
await mkdir('release', { recursive: true })
await writeFile('release/Flowra-1.0.0-source.zip', zipSync(files, { level: 6 }))
console.log('Исходники: release/Flowra-1.0.0-source.zip')
