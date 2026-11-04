import { nodeKinds, type Workflow } from './types'

export function initialWorkflow(): Workflow {
  return { version: 1, nodes: [
    { id: 'start', type: 'start', position: { x: 100, y: 180 }, data: { label: 'Начало', command: '/start' } },
    { id: 'welcome', type: 'sendMessage', position: { x: 440, y: 180 }, data: { label: 'Приветствие', text: 'Привет, {{user.first_name}}! Рад тебя видеть.', parseMode: '' } },
  ], edges: [{ id: 'start-welcome', source: 'start', target: 'welcome' }] }
}

export function validateWorkflow(value: unknown): asserts value is Workflow {
  const workflow = value as Workflow
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) throw new Error('Сценарий повреждён: нужны массивы блоков и связей.')
  if (workflow.nodes.length > 5000 || workflow.edges.length > 10000) throw new Error('В сценарии слишком много блоков или связей.')
  const ids = new Set<string>()
  for (const node of workflow.nodes) {
    if (!node.id || ids.has(node.id) || !nodeKinds.includes(node.type) || !node.data || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new Error('Сценарий содержит некорректный блок.')
    ids.add(node.id)
  }
  const edges = new Set<string>()
  for (const edge of workflow.edges) {
    if (!edge.id || edges.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('Сценарий содержит некорректную связь.')
    edges.add(edge.id)
  }
}

export function referencedAssets(workflow: Workflow): Set<string> {
  const found = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string' && /^assets\/[a-zA-Z0-9._-]+$/.test(value)) found.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  workflow.nodes.forEach(node => visit(node.data))
  return found
}
