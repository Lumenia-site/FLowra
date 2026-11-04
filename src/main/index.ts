import { app, BrowserWindow, session, ipcMain, dialog } from 'electron'
import path from 'node:path'
import { FlowraDatabase } from '../database/database'
import { AssetService } from './assets'
import { ProcessManager } from './processes'
import { registerIpc } from './ipc'
import type { AppEvent } from '../shared/types'

let window: BrowserWindow | undefined
let database: FlowraDatabase | undefined
let processes: ProcessManager | undefined

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
  void app.whenReady().then(() => {
    app.setAppUserModelId('org.flowra.desktop')
    const root = process.env.FLOWRA_DATA_DIR || app.getPath('userData')
    const databasePath = path.join(root, 'flowra.sqlite')
    database = new FlowraDatabase(databasePath)
    database.recover()
    window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1040, minHeight: 680, title: 'Flowra', backgroundColor: '#f6f5f3', autoHideMenuBar: true, show: false, icon: path.join(app.getAppPath(), app.isPackaged ? 'dist/icon.ico' : 'src/assets/icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } })
    window.removeMenu()
    const emit = (event: AppEvent) => { if (window && !window.isDestroyed()) window.webContents.send('flowra:event', event) }
    const assets = new AssetService(database, path.join(root, 'projects'))
    processes = new ProcessManager(database, databasePath, assets, emit)
    registerIpc(window, database, assets, processes, app.isPackaged ? path.join(process.resourcesPath, 'flowra') : path.join(app.getAppPath(), 'resources'), emit)
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    let allowClose = false
    let closing = false
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const closeWithoutSaving = async (message: string) => {
      if (!window || window.isDestroyed()) return
      const answer = await dialog.showMessageBox(window, { type: 'error', title: 'Не удалось сохранить сценарий', message, buttons: ['Остаться в приложении', 'Закрыть без сохранения'], defaultId: 0, cancelId: 0 })
      if (answer.response === 1) { allowClose = true; window.close() }
      else closing = false
    }
    window.on('close', event => {
      if (allowClose) return
      event.preventDefault()
      if (closing) return
      closing = true
      window?.webContents.send('flowra:before-close')
      closeTimer = setTimeout(() => { void closeWithoutSaving('Интерфейс не ответил на запрос сохранения. Можно остаться и попробовать ещё раз.') }, 10000)
    })
    ipcMain.on('flowra:close-ready', (event, result) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !closing) return
      clearTimeout(closeTimer)
      if (result?.error) { void closeWithoutSaving(String(result.error)); return }
      allowClose = true
      window.close()
    })
    window.on('ready-to-show', () => window?.show())
    window.on('closed', () => { window = undefined })
    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl === 'http://127.0.0.1:5173') void window.loadURL(devUrl)
    else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }).catch(error => { console.error(String(error.message).replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '[токен скрыт]')); app.quit() })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => { processes?.dispose(); database?.close(); database = undefined })
}
