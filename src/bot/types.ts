import type { Workflow } from '../shared/types'
import type { TelegramClient } from './telegram'

export interface TelegramUser { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }
export interface RuntimeUser { id: number; telegramUserId: number; chatId: number }
export interface RuntimeStore {
  upsertUser(from: TelegramUser, chatId: number): Promise<RuntimeUser>
  getVariables(userId: number): Promise<Record<string, any>>
  setVariable(userId: number, key: string, value: any): Promise<void>
  getCurrentNode(userId: number): Promise<string | null>
  setCurrentNode(userId: number, nodeId: string | null): Promise<void>
  getOffset?(): Promise<number>
  setOffset?(offset: number): Promise<void>
}
export interface RuntimeOptions {
  workflow: Workflow
  telegram: TelegramClient
  store: RuntimeStore
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  signal?: AbortSignal
}
export interface ExecutionContext {
  userId: number
  chatId: number
  values: Record<string, any>
  signal?: AbortSignal
}
