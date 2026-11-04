import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import electron from 'electron'

await build({ entryPoints: ['tests/desktop-smoke.ts'], outfile: '.test-output/desktop-smoke.cjs', platform: 'node', target: 'node22', format: 'cjs', bundle: true, external: ['electron'] })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.test-output/desktop-smoke.cjs'], { stdio: 'inherit', env, windowsHide: true })
child.on('exit', code => process.exit(code ?? 1))
