import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { FlowraDatabase } from '../database/database'
import type { AssetService } from './assets'
import type { AppEvent } from '../shared/types'
import { decryptToken, redactSecrets } from './secrets'

interface Worker { process: UtilityProcess; ready: Promise<void>; start?: { resolve: () => void; reject: (error: Error) => void }; stop?: () => void; closing: boolean }

export class ProcessManager {
  private workers = new Map<string, Worker>()

  constructor(private database: FlowraDatabase, private databasePath: string, private assets: AssetService, private emit: (event: AppEvent) => void) {}

  private ensure(projectId: string) {
    const existing = this.workers.get(projectId)
    if (existing) return existing
    const token = decryptToken(this.database.getToken(projectId))
    const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], { serviceName: 'Flowra Telegram', stdio: 'pipe' })
    let resolve!: () => void
    let reject!: (error: Error) => void
    const worker: Worker = { process: child, ready: new Promise<void>((yes, no) => { resolve = yes; reject = no }), closing: false }
    this.workers.set(projectId, worker)
    let initialized = false
    const initTimer = setTimeout(() => { reject(new Error('Процесс бота не ответил при запуске.')); this.terminate(projectId) }, 15000)
    child.on('message', (message: any) => {
      if (message.ready) { initialized = true; clearTimeout(initTimer); resolve() }
      if (message.event) this.emit(message.event)
      if (message.started) { worker.start?.resolve(); worker.start = undefined }
      if (message.stopped) { worker.stop?.(); worker.stop = undefined }
      if (message.startError) { worker.start?.reject(new Error(redactSecrets(message.startError))); worker.start = undefined }
      if (message.error) {
        if (!initialized) { clearTimeout(initTimer); reject(new Error(redactSecrets(message.error))); this.terminate(projectId) }
        const entry = this.database.log(projectId, 'error', redactSecrets(message.error)); this.emit({ type: 'log', projectId, data: entry })
      }
    })
    child.on('exit', code => {
      clearTimeout(initTimer)
      if (this.workers.get(projectId) === worker) this.workers.delete(projectId)
      reject(new Error('Процесс бота завершился до запуска.'))
      worker.start?.reject(new Error('Процесс бота завершился.'))
      if (!worker.closing) {
        this.database.setStatus(projectId, code === 0 ? 'stopped' : 'error')
        this.database.listBroadcasts(projectId).filter(b => ['queued', 'running'].includes(b.status)).forEach(b => this.database.broadcastStatus(b.id, 'interrupted'))
        this.emit({ type: 'status', projectId, data: code === 0 ? 'stopped' : 'error' })
        const entry = this.database.log(projectId, code === 0 ? 'info' : 'error', `Процесс бота завершился с кодом ${code}.`)
        this.emit({ type: 'log', projectId, data: entry })
      }
    })
    child.stderr?.on('data', buffer => {
      if (worker.closing) return
      const message = redactSecrets(buffer.toString())
      if (!message.includes('ExperimentalWarning') && !message.includes('trace-warnings')) {
        const entry = this.database.log(projectId, 'warn', message)
        this.emit({ type: 'log', projectId, data: entry })
      }
    })
    child.postMessage({ type: 'init', projectId, token, databasePath: this.databasePath, projectRoot: this.assets.projectRoot(projectId) })
    return worker
  }

  async start(projectId: string) {
    if (this.database.getProject(projectId).status === 'running') return
    const worker = this.ensure(projectId)
    await worker.ready
    if (worker.start) throw new Error('Бот уже запускается.')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { worker.start = undefined; reject(new Error('Telegram не ответил вовремя. Проверьте соединение и журнал.')); worker.process.postMessage({ type: 'stop' }) }, 45000)
      worker.start = { resolve: () => { clearTimeout(timer); resolve() }, reject: error => { clearTimeout(timer); reject(error) } }
      worker.process.postMessage({ type: 'start' })
    })
  }

  async stop(projectId: string) {
    const worker = this.workers.get(projectId)
    if (worker) {
      await worker.ready
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.terminate(projectId); reject(new Error('Процесс не ответил на остановку и был принудительно завершён. Активная рассылка прервана.')) }, 5000)
        worker.stop = () => { clearTimeout(timer); resolve() }
        worker.process.postMessage({ type: 'stop' })
      })
    }
    this.database.setStatus(projectId, 'stopped')
    this.emit({ type: 'status', projectId, data: 'stopped' })
    if (!this.database.listBroadcasts(projectId).some(b => ['queued', 'running'].includes(b.status))) this.terminate(projectId)
  }
  async broadcast(projectId: string, id: string) { const worker = this.ensure(projectId); await worker.ready; worker.process.postMessage({ type: 'broadcast', id }) }
  cancel(projectId: string, id: string) { if (!['queued', 'running'].includes(this.database.getBroadcast(id).status)) return; this.workers.get(projectId)?.process.postMessage({ type: 'cancel', id }); this.database.broadcastStatus(id, 'cancelled'); this.emit({ type: 'broadcast', projectId, data: this.database.getBroadcast(id) }) }
  terminate(projectId: string) { const worker = this.workers.get(projectId); if (worker) { worker.closing = true; worker.start?.reject(new Error('Процесс бота остановлен.')); worker.process.kill(); this.workers.delete(projectId) } this.database.setStatus(projectId, 'stopped'); this.database.listBroadcasts(projectId).filter(b => ['queued', 'running'].includes(b.status)).forEach(b => this.database.broadcastStatus(b.id, 'interrupted')); this.emit({ type: 'status', projectId, data: 'stopped' }) }
  dispose() { for (const id of this.workers.keys()) this.terminate(id) }
}
