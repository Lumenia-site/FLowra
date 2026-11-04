import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FlowraDatabase } from '../database/database'
import type { AppEvent, BroadcastContent, FlowraAPI } from '../shared/types'
import { nodeKinds } from '../shared/types'
import type { AssetService } from './assets'
import type { ProcessManager } from './processes'
import { encryptToken, decryptToken, redactSecrets } from './secrets'
import { TelegramClient } from '../bot/telegram'
import { exportProject } from '../exporter'

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error('Укажите название от 1 до 100 символов.')
  return value.trim()
}

async function verifyToken(token: string) {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Неверный формат Telegram Bot Token. Скопируйте токен целиком из @BotFather.')
  const me = await new TelegramClient(token, '').call('getMe', {}, AbortSignal.timeout(15000))
  if (!me.is_bot) throw new Error('Этот токен не принадлежит Telegram-боту.')
  return me.username as string
}

function csv(value: unknown) {
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}

export function registerIpc(window: BrowserWindow, database: FlowraDatabase, assets: AssetService, processes: ProcessManager, resourcesRoot: string, emit: (event: AppEvent) => void) {
  const starting = new Set<string>()
  const handlers: Omit<FlowraAPI, 'onEvent' | 'onBeforeClose'> = {
    listProjects: async () => database.listProjects(),
    createProject: async input => {
      const projectName = name(input.name)
      const token = String(input.token ?? '').trim()
      const username = token ? await verifyToken(token) : null
      const project = database.createProject(projectName, token ? encryptToken(token) : null, username)
      try { await mkdir(path.join(assets.projectRoot(project.id), 'assets'), { recursive: true }) } catch (error) { database.deleteProject(project.id); throw error }
      return project
    },
    updateProject: async input => {
      database.getProject(input.id)
      const update: { name?: string; token?: string | null; username?: string | null } = {}
      if (input.name !== undefined) update.name = name(input.name)
      if (input.token !== undefined) {
        const token = input.token.trim()
        update.username = token ? await verifyToken(token) : null
        update.token = token ? encryptToken(token) : null
        processes.terminate(input.id)
      }
      return database.updateProject(input.id, update)
    },
    deleteProject: async id => {
      const root = assets.projectRoot(id)
      processes.terminate(id)
      await rm(root, { recursive: true, force: true })
      database.deleteProject(id)
    },
    duplicateProject: async id => {
      const source = database.getProject(id)
      const project = database.createProject(`${source.name.slice(0, 90)} — копия`, null, null, source.workflow)
      try {
        await mkdir(assets.projectRoot(project.id), { recursive: true })
        await cp(assets.projectRoot(id), assets.projectRoot(project.id), { recursive: true })
        for (const asset of database.listAssets(id)) database.addAsset({ ...asset, id: crypto.randomUUID(), projectId: project.id })
        return project
      } catch (error) { await rm(assets.projectRoot(project.id), { recursive: true, force: true }); database.deleteProject(project.id); throw error }
    },
    saveWorkflow: async input => { database.saveWorkflow(input.id, input.workflow) },
    startBot: async id => {
      const token = decryptToken(database.getToken(id))
      if (starting.has(token)) throw new Error('Бот с этим токеном уже запускается.')
      for (const project of database.listProjects()) {
        if (project.id !== id && project.status === 'running' && database.getToken(project.id) && decryptToken(database.getToken(project.id)) === token) throw new Error('Этот токен уже используется другим запущенным проектом.')
      }
      starting.add(token)
      try { await processes.start(id) } finally { starting.delete(token) }
    },
    stopBot: async id => { database.getProject(id); await processes.stop(id) },
    listLogs: async id => { database.getProject(id); return database.listLogs(id) },
    clearLogs: async id => { database.getProject(id); database.clearLogs(id) },
    listUsers: async input => { database.getProject(input.projectId); return database.listUsers(input.projectId, input.filters) },
    setUserVariables: async input => {
      if (!input.variables || Array.isArray(input.variables) || typeof input.variables !== 'object') throw new Error('Переменные должны быть JSON-объектом.')
      database.setUserVariables(input.projectId, input.userId, input.variables)
      emit({ type: 'users', projectId: input.projectId })
    },
    deleteUser: async input => { database.deleteUser(input.projectId, input.userId); emit({ type: 'users', projectId: input.projectId }) },
    exportUsers: async input => {
      database.getProject(input.projectId)
      const result = await dialog.showSaveDialog(window, { title: 'Экспорт пользователей', defaultPath: 'users.csv', filters: [{ name: 'Таблица CSV', extensions: ['csv'] }] })
      if (result.canceled || !result.filePath) return null
      const users = database.listUsers(input.projectId, input.filters)
      const header = ['Telegram ID', 'Chat ID', 'Имя пользователя', 'Имя', 'Фамилия', 'Язык', 'Первый запуск', 'Активность', 'Сообщения', 'Переменные']
      const rows = users.map(u => [u.telegramUserId, u.chatId, u.username, u.firstName, u.lastName, u.languageCode, u.firstStartedAt, u.lastActivityAt, u.messageCount, u.variables].map(csv).join(','))
      await writeFile(result.filePath, '\uFEFF' + [header.map(csv).join(','), ...rows].join('\r\n'), 'utf8')
      return result.filePath
    },
    listBroadcasts: async id => { database.getProject(id); return database.listBroadcasts(id) },
    createBroadcast: async input => {
      database.getProject(input.projectId)
      decryptToken(database.getToken(input.projectId))
      validateContent(input.content)
      const campaign = database.createBroadcast(input.projectId, input.content, input.filters ?? {})
      try { await processes.broadcast(input.projectId, campaign.id) } catch (error) { database.broadcastStatus(campaign.id, 'interrupted'); throw error }
      return campaign
    },
    cancelBroadcast: async id => { const campaign = database.getBroadcast(id); processes.cancel(campaign.projectId, id) },
    pickAsset: async input => {
      database.getProject(input.projectId)
      if (!nodeKinds.includes(input.kind)) throw new Error('Неизвестный тип блока.')
      const result = await dialog.showOpenDialog(window, { title: 'Добавить файл в проект', properties: ['openFile'] })
      if (result.canceled || !result.filePaths[0]) return null
      return assets.importFile(input.projectId, input.kind, result.filePaths[0])
    },
    listAssets: async id => assets.list(id),
    cleanupAssets: async id => assets.cleanup(id),
    exportBot: async input => {
      const project = database.getProject(input.projectId)
      if (!['javascript', 'python'].includes(input.language)) throw new Error('Выберите язык экспорта.')
      const result = await dialog.showSaveDialog(window, { title: 'Экспорт бота', defaultPath: `${project.name.replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 70)}-${input.language}.zip`, filters: [{ name: 'ZIP-архив', extensions: ['zip'] }] })
      if (result.canceled || !result.filePath) return null
      await exportProject({ project, projectRoot: assets.projectRoot(project.id), outputPath: result.filePath, language: input.language, resourcesRoot })
      return result.filePath
    },
    getSettings: async () => database.getSetting('app', { theme: 'system' }),
    setSettings: async settings => { if (!['light', 'dark', 'system'].includes(settings.theme)) throw new Error('Неизвестная тема.'); database.setSetting('app', { theme: settings.theme }) },
  }

  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`flowra:${method}`, async (event, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Доступ запрещён.')
      try {
        if (input !== undefined && Buffer.byteLength(JSON.stringify(input)) > 10 * 1024 * 1024) throw new Error('Слишком большой запрос.')
        return await (handler as (input: any) => Promise<any>)(input)
      } catch (error: any) { throw new Error(redactSecrets(error.message ?? 'Не удалось выполнить действие.')) }
    })
  }
}

function validateContent(content: BroadcastContent) {
  if (!content || !['sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument'].includes(content.type)) throw new Error('Выберите тип сообщения.')
  if (content.type === 'sendMessage' && (!content.text?.trim() || content.text.length > 4096)) throw new Error('Текст сообщения должен содержать от 1 до 4096 символов.')
  if (content.type !== 'sendMessage' && !content.media?.trim()) throw new Error('Добавьте файл или ссылку на медиа.')
  if ((content.caption?.length ?? 0) > 1024) throw new Error('Подпись не должна превышать 1024 символа.')
}
