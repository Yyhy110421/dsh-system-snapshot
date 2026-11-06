/**
 * 快照仓库与业务流程：创建、列出、比较、恢复、设置。
 *
 * 这一层负责文件落盘和调用 PowerShell；纯差异逻辑在 core.js。
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertSnapshot,
  cleanLabel,
  countCategories,
  diffSnapshots,
  isValidSnapshotId,
  makeSnapshotId,
  normalizeRestore,
  normalizeSettings,
  snapshotSummary,
} from './core.js'

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeAtomic(path, text) {
  const temp = path + '.tmp-' + randomBytes(4).toString('hex')
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, path)
}

export function createService({ dataDir, runPowerShell, config = {}, now = () => new Date() }) {
  if (typeof runPowerShell !== 'function') throw new Error('缺少 PowerShell runner。')
  const root = resolve(dataDir)
  const snapshotsDir = join(root, 'snapshots')
  const tempDir = join(root, 'tmp')
  const settingsFile = join(root, 'settings.json')
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(tempDir, { recursive: true })

  let settings = normalizeSettings(readJson(settingsFile, config || {}))

  function publicSettings() {
    return JSON.parse(JSON.stringify(settings))
  }

  function saveSettings(patch) {
    const value = patch && typeof patch === 'object' ? patch : {}
    settings = normalizeSettings({ ...settings, ...value })
    writeAtomic(settingsFile, JSON.stringify(settings, null, 2))
    return publicSettings()
  }

  function snapshotPath(id) {
    if (!isValidSnapshotId(id)) throw new Error('快照 ID 不合法。')
    const path = join(snapshotsDir, id + '.json')
    if (resolve(path) !== path) throw new Error('快照路径越界。')
    return path
  }

  function readSnapshot(id) {
    const path = snapshotPath(id)
    if (!existsSync(path)) throw new Error('找不到快照：' + id)
    const parsed = readJson(path, null)
    if (!parsed) throw new Error('快照文件无法解析：' + id)
    return assertSnapshot(parsed)
  }

  function writeSnapshot(snapshot) {
    writeAtomic(snapshotPath(snapshot.id), JSON.stringify(snapshot))
  }

  async function collect(label, persist) {
    const createdAt = now().toISOString()
    const id = makeSnapshotId(now(), randomBytes(2).toString('hex'))
    const outFile = join(tempDir, id + '.json')
    try {
      await runPowerShell({
        action: 'create',
        outFile,
        settings: publicSettings(),
      })
      const collected = readJson(outFile, null)
      if (!collected || !collected.categories) {
        throw new Error('PowerShell 没有生成有效的快照内容。')
      }
      const snapshot = {
        version: 1,
        id,
        label: cleanLabel(label),
        createdAt,
        host: hostname(),
        platform: process.platform,
        settings: publicSettings(),
        categories: collected.categories,
        counts: collected.counts || countCategories(collected.categories),
      }
      assertSnapshot(snapshot)
      if (persist) writeSnapshot(snapshot)
      return snapshot
    } finally {
      rmSync(outFile, { force: true })
    }
  }

  async function create(label) {
    const snapshot = await collect(label, true)
    prune()
    return snapshotSummary(snapshot)
  }

  async function collectCurrent() {
    const snapshot = await collect('当前状态', false)
    return { ...snapshot, id: 'current' }
  }

  function list() {
    if (!existsSync(snapshotsDir)) return []
    const out = []
    for (const name of readdirSync(snapshotsDir)) {
      if (!name.endsWith('.json')) continue
      const parsed = readJson(join(snapshotsDir, name), null)
      if (!parsed || parsed.version !== 1 || !isValidSnapshotId(parsed.id)) continue
      out.push(snapshotSummary(parsed))
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return out
  }

  async function diff(id, compareTo, maxItems) {
    const from = readSnapshot(id)
    let to
    if (!compareTo || compareTo === 'current') {
      to = await collectCurrent()
    } else {
      to = readSnapshot(compareTo)
    }
    return diffSnapshots(from, to, { maxItems: maxItems || settings.diffMaxItems })
  }

  async function restore(args) {
    const checked = normalizeRestore(args)
    if (!checked.ok) throw new Error(checked.error)
    const target = readSnapshot(checked.value.id)
    const backup = await create('恢复前自动备份')
    const result = await runPowerShell({
      action: 'restore',
      snapshot: target,
      categories: checked.value.categories,
    })
    return {
      ok: true,
      target: snapshotSummary(target),
      backup: backup.id,
      categories: checked.value.categories,
      restored: Array.isArray(result.restored) ? result.restored : [],
      skipped: Array.isArray(result.skipped) ? result.skipped : [],
      errors: Array.isArray(result.errors) ? result.errors : [],
      partial: result.partial === true,
    }
  }

  function prune() {
    const entries = []
    if (!existsSync(snapshotsDir)) return
    for (const name of readdirSync(snapshotsDir)) {
      if (!name.endsWith('.json')) continue
      const path = join(snapshotsDir, name)
      const parsed = readJson(path, null)
      if (!parsed || !isValidSnapshotId(parsed.id)) continue
      entries.push({ path, createdAt: Date.parse(parsed.createdAt) || 0 })
    }
    entries.sort((a, b) => b.createdAt - a.createdAt)
    const cutoff = now().getTime() - settings.keepDays * 24 * 60 * 60 * 1000
    const keep = new Set(entries.slice(0, settings.maxSnapshots).map((entry) => entry.path))
    for (const entry of entries) {
      if (keep.has(entry.path) && entry.createdAt >= cutoff) continue
      rmSync(entry.path, { force: true })
    }
  }

  return {
    create,
    list,
    get: readSnapshot,
    diff,
    restore,
    prune,
    getSettings: publicSettings,
    saveSettings,
    paths: { root, snapshotsDir, tempDir, settingsFile },
  }
}
