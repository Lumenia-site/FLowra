import { app, utilityProcess, safeStorage } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { FlowraDatabase } from '../src/database/database'

void app.whenReady().then(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flowra-desktop-'))
  const filename = path.join(root, 'flowra.sqlite')
  const database = new FlowraDatabase(filename)
  const project = database.createProject('Проверка IPC', null, null)
  let child: ReturnType<typeof utilityProcess.fork> | undefined
  try {
    assert.ok(safeStorage.isEncryptionAvailable(), 'Системное шифрование недоступно')
    const encrypted = safeStorage.encryptString('flowra-test-secret')
    assert.equal(safeStorage.decryptString(encrypted), 'flowra-test-secret')
    child = utilityProcess.fork(path.resolve('dist/main/worker.cjs'), [], { stdio: 'pipe' })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Utility process не ответил')), 10000)
      child!.on('exit', code => { clearTimeout(timer); reject(new Error(`Процесс завершился: ${code}`)) })
      child!.on('message', message => {
        if (message.error) { clearTimeout(timer); reject(new Error(message.error)) }
        if (message.ready) child!.postMessage({ type: 'stop' })
        if (message.stopped) { clearTimeout(timer); resolve() }
      })
      child!.postMessage({ type: 'init', databasePath: filename, projectId: project.id, projectRoot: root, token: 'not-a-real-token' })
    })
    assert.equal(database.getProject(project.id).name, 'Проверка IPC')
    console.log('PASS: Electron safeStorage, SQLite и utility process IPC')
  } finally {
    if (child) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
      child.kill()
      await exited
    }
    database.close()
    await rm(root, { recursive: true, force: true })
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
