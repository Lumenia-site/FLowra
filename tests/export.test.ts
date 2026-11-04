import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { unzipSync, strFromU8 } from 'fflate'
import { build } from 'esbuild'
import { exportProject } from '../src/exporter/index'
import { initialWorkflow } from '../src/shared/workflow'
import type { Project } from '../src/shared/types'

test('ZIP exports contain used assets and runnable entrypoints, without tokens or user data', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'flowra-export-'))
  try {
    const assets = resolve(temp, 'project/assets')
    const resources = resolve(temp, 'resources')
    await mkdir(assets, { recursive: true })
    await mkdir(resolve(resources, 'javascript'), { recursive: true })
    await mkdir(resolve(resources, 'python'), { recursive: true })
    await writeFile(resolve(assets, 'photo.png'), new Uint8Array([137, 80, 78, 71]))
    await writeFile(resolve(assets, 'unused.png'), 'unused')
    await writeFile(resolve(temp, 'project/real-users.db'), 'sensitive users')
    await writeFile(resolve(resources, 'LICENSE'), 'GNU GPL v3')
    await build({ entryPoints: ['src/exporter/javascript/entry.ts'], outfile: resolve(resources, 'javascript/runtime.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' })
    await cp('src/bot', resolve(resources, 'javascript/source/src/bot'), { recursive: true })
    await cp('src/shared', resolve(resources, 'javascript/source/src/shared'), { recursive: true })
    await cp('src/exporter/javascript', resolve(resources, 'javascript/source/src/exporter/javascript'), { recursive: true })
    for (const name of ['index.py', 'api.py', 'engine.py', 'storage.py']) await writeFile(resolve(resources, 'python', name), await readFile(resolve('src/exporter/python', name)))
    const workflow = initialWorkflow()
    workflow.nodes.push({ id: 'photo', type: 'sendPhoto', position: { x: 1, y: 1 }, data: { media: 'assets/photo.png' } })
    const project: Project = { id: 'test', name: 'Мой бот', username: 'test_bot', status: 'stopped', userCount: 3, createdAt: '', updatedAt: '', hasToken: true, workflow }
    for (const language of ['javascript', 'python'] as const) {
      const outputPath = resolve(temp, `${language}.zip`)
      await exportProject({ project, projectRoot: resolve(temp, 'project'), outputPath, language, resourcesRoot: resources })
      const zip = unzipSync(await readFile(outputPath))
      const names = Object.keys(zip)
      assert.ok(names.includes('flowra-bot/assets/photo.png'))
      assert.ok(names.includes('flowra-bot/workflow.json'))
      assert.ok(names.includes('flowra-bot/.env.example'))
      assert.ok(names.includes('flowra-bot/LICENSE'))
      assert.ok(!names.some(name => /unused|\.db|node_modules|(^|\/)\.env$/.test(name)))
      assert.ok(strFromU8(zip['flowra-bot/.env.example']).includes('TELEGRAM_BOT_TOKEN='))
      if (language === 'javascript') {
        assert.ok(names.includes('flowra-bot/source/src/bot/runtime.ts'))
        assert.ok(names.includes('flowra-bot/source/src/shared/workflow.ts'))
        assert.ok(names.includes('flowra-bot/source/src/exporter/javascript/entry.ts'))
        assert.ok(names.includes('flowra-bot/source/package.json'))
        assert.ok(names.includes('flowra-bot/source/build.mjs'))
        assert.equal(JSON.parse(strFromU8(zip['flowra-bot/package.json'])).engines.node, '>=22.18.0')
      }
      const folder = resolve(temp, language)
      for (const [name, bytes] of Object.entries(zip)) {
        const target = resolve(folder, name)
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, bytes)
      }
      if (language === 'javascript') {
        const sourceRoot = resolve(folder, 'flowra-bot/source')
        await build({ absWorkingDir: sourceRoot, entryPoints: ['src/exporter/javascript/entry.ts'], outfile: resolve(sourceRoot, '../runtime.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' })
      }
      const entry = resolve(folder, 'flowra-bot', language === 'javascript' ? 'index.js' : 'index.py')
      const result = spawnSync(language === 'javascript' ? process.execPath : 'python', [entry], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, TELEGRAM_BOT_TOKEN: '', PYTHONDONTWRITEBYTECODE: '1' } })
      assert.equal(result.status, 1, result.stderr || result.stdout)
      assert.match(result.stdout + result.stderr, /TELEGRAM_BOT_TOKEN/)
      assert.doesNotMatch(result.stdout + result.stderr, /MODULE_NOT_FOUND|ModuleNotFoundError|SyntaxError/)
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('export refuses missing referenced media', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'flowra-missing-'))
  try {
    const workflow = initialWorkflow()
    workflow.nodes[1].data.media = 'assets/missing.png'
    const project = { name: 'test', workflow } as Project
    await assert.rejects(exportProject({ project, projectRoot: temp, outputPath: resolve(temp, 'bot.zip'), language: 'python' }), /медиафайл/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('Python runtime persists input, executes branches and serializes all Telegram payloads', () => {
  const result = spawnSync('python', ['tests/export-python.py'], { cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
