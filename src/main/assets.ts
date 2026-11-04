import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FlowraDatabase } from '../database/database'
import type { Asset, NodeKind } from '../shared/types'
import { referencedAssets } from '../shared/workflow'
import { validateMediaFile } from '../bot/media'

const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.pdf': 'application/pdf' }

export class AssetService {
  constructor(private database: FlowraDatabase, readonly projectsRoot: string) {}

  projectRoot(projectId: string) {
    this.database.getProject(projectId)
    if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('Недопустимый идентификатор проекта.')
    return path.join(this.projectsRoot, projectId)
  }

  async importFile(projectId: string, kind: NodeKind, filename: string): Promise<Asset> {
    const root = this.projectRoot(projectId)
    const info = await stat(filename)
    if (!info.isFile()) throw new Error('Выберите обычный файл.')
    validateMediaFile(kind, filename, info.size)
    const id = randomUUID()
    const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 15)
    const relative = `assets/${id}${ext}`
    await mkdir(path.join(root, 'assets'), { recursive: true })
    await copyFile(filename, path.join(root, relative))
    const asset: Asset = { id, projectId, path: relative, name: path.basename(filename), size: info.size, mime: mimeTypes[ext] ?? 'application/octet-stream' }
    try { this.database.addAsset(asset) } catch (error) { await unlink(path.join(root, relative)); throw error }
    return this.withPreview(asset)
  }

  private async withPreview(asset: Asset): Promise<Asset> {
    if (!/^image\//.test(asset.mime)) return asset
    try { return { ...asset, preview: `data:${asset.mime};base64,${(await readFile(path.join(this.projectRoot(asset.projectId), asset.path))).toString('base64')}` } } catch { return asset }
  }

  private used(projectId: string) {
    const used = referencedAssets(this.database.getProject(projectId).workflow)
    for (const broadcast of this.database.listBroadcasts(projectId)) {
      if (broadcast.content.media?.startsWith('assets/')) used.add(broadcast.content.media)
    }
    return used
  }

  async list(projectId: string): Promise<Asset[]> {
    const used = this.used(projectId)
    return Promise.all(this.database.listAssets(projectId).map(async asset => ({ ...await this.withPreview(asset), unused: !used.has(asset.path) })))
  }

  async cleanup(projectId: string): Promise<number> {
    const root = this.projectRoot(projectId)
    const used = this.used(projectId)
    let count = 0
    for (const asset of this.database.listAssets(projectId)) {
      if (used.has(asset.path) || !/^assets\/[a-zA-Z0-9._-]+$/.test(asset.path)) continue
      try { await unlink(path.join(root, asset.path)) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
      this.database.deleteAsset(asset.id)
      count++
    }
    return count
  }
}
