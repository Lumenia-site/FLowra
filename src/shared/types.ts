export const nodeKinds = ['start', 'command', 'message', 'callback', 'sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument', 'sendLocation', 'sendContact', 'sendPoll', 'sendQuiz', 'sendMediaGroup', 'editMessage', 'deleteMessage', 'inlineKeyboard', 'replyKeyboard', 'urlButton', 'condition', 'switch', 'delay', 'random', 'variable', 'setVariable', 'getVariable', 'input', 'http'] as const

export type NodeKind = typeof nodeKinds[number]
export type NodeData = { label?: string; [key: string]: any }
export interface FlowNode { id: string; type: NodeKind; position: { x: number; y: number }; data: NodeData; selected?: boolean }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; selected?: boolean }
export interface Workflow { version: 1; nodes: FlowNode[]; edges: FlowEdge[] }
export type ProjectStatus = 'stopped' | 'running' | 'error'
export interface Project { id: string; name: string; username: string | null; status: ProjectStatus; userCount: number; createdAt: string; updatedAt: string; hasToken: boolean; workflow: Workflow }
export interface BotUser { id: number; projectId: string; telegramUserId: number; chatId: number; username: string | null; firstName: string; lastName: string | null; languageCode: string | null; firstStartedAt: string; lastActivityAt: string; messageCount: number; currentNode: string | null; blocked: boolean; variables: Record<string, any> }
export interface UserFilter { search?: string; languageCode?: string; activeDays?: number; variable?: string; operator?: string; value?: string; blocked?: boolean; username?: 'exists' | 'missing'; firstStartedAfter?: string; lastActivityAfter?: string }
export interface Asset { id: string; projectId: string; path: string; name: string; mime: string; size: number; unused?: boolean; preview?: string }
export interface BroadcastContent { type: 'sendMessage' | 'sendPhoto' | 'sendVideo' | 'sendDocument'; text?: string; media?: string; caption?: string; parseMode?: string }
export interface Broadcast { id: string; projectId: string; content: BroadcastContent; filters: UserFilter; status: 'queued' | 'running' | 'completed' | 'cancelled' | 'interrupted'; total: number; sent: number; failed: number; createdAt: string; startedAt: string | null; completedAt: string | null }
export interface LogEntry { id: number; projectId: string; level: 'info' | 'error' | 'warn'; message: string; createdAt: string }
export interface AppEvent { type: 'log' | 'status' | 'broadcast' | 'users'; projectId: string; data?: any }
export interface AppSettings { theme: 'light' | 'dark' | 'system' }
export interface FlowraAPI {
  listProjects(): Promise<Project[]>
  createProject(input: { name: string; token: string }): Promise<Project>
  updateProject(input: { id: string; name?: string; token?: string }): Promise<Project>
  deleteProject(id: string): Promise<void>
  duplicateProject(id: string): Promise<Project>
  saveWorkflow(input: { id: string; workflow: Workflow }): Promise<void>
  startBot(id: string): Promise<void>
  stopBot(id: string): Promise<void>
  listLogs(id: string): Promise<LogEntry[]>
  clearLogs(id: string): Promise<void>
  listUsers(input: { projectId: string; filters?: UserFilter }): Promise<BotUser[]>
  setUserVariables(input: { projectId: string; userId: number; variables: Record<string, any> }): Promise<void>
  deleteUser(input: { projectId: string; userId: number }): Promise<void>
  exportUsers(input: { projectId: string; filters?: UserFilter }): Promise<string | null>
  listBroadcasts(projectId: string): Promise<Broadcast[]>
  createBroadcast(input: { projectId: string; content: BroadcastContent; filters: UserFilter }): Promise<Broadcast>
  cancelBroadcast(id: string): Promise<void>
  pickAsset(input: { projectId: string; kind: NodeKind }): Promise<Asset | null>
  listAssets(projectId: string): Promise<Asset[]>
  cleanupAssets(projectId: string): Promise<number>
  exportBot(input: { projectId: string; language: 'javascript' | 'python' }): Promise<string | null>
  getSettings(): Promise<AppSettings>
  setSettings(settings: AppSettings): Promise<void>
  onEvent(listener: (event: AppEvent) => void): () => void
  onBeforeClose(listener: () => Promise<void>): () => void
}
