import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, FlowraAPI } from '../shared/types'

const methods = ['listProjects', 'createProject', 'updateProject', 'deleteProject', 'duplicateProject', 'saveWorkflow', 'startBot', 'stopBot', 'listLogs', 'clearLogs', 'listUsers', 'setUserVariables', 'deleteUser', 'exportUsers', 'listBroadcasts', 'createBroadcast', 'cancelBroadcast', 'pickAsset', 'listAssets', 'cleanupAssets', 'exportBot', 'getSettings', 'setSettings'] as const
const api = Object.fromEntries(methods.map(method => [method, (input: unknown) => ipcRenderer.invoke(`flowra:${method}`, input)])) as unknown as FlowraAPI
api.onEvent = listener => {
  const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent) => listener(payload)
  ipcRenderer.on('flowra:event', handler)
  return () => ipcRenderer.removeListener('flowra:event', handler)
}
let closeListener: (() => Promise<void>) | undefined
api.onBeforeClose = listener => { closeListener = listener; return () => { if (closeListener === listener) closeListener = undefined } }
ipcRenderer.on('flowra:before-close', async () => {
  try { await closeListener?.(); ipcRenderer.send('flowra:close-ready', {}) } catch (error: any) { ipcRenderer.send('flowra:close-ready', { error: String(error.message) }) }
})
contextBridge.exposeInMainWorld('flowra', api)
