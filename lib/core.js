/**
 * dsh-system-snapshot 的纯逻辑层：设置、白名单、快照摘要、差异计算。
 *
 * 这里不跑 PowerShell、不写文件，方便单测。
 * 只快照白名单；服务/防火墙/计划任务/系统环境变量永远只读。
 */

export const CATEGORY_META = {
  registry: {
    label: '注册表',
    restorable: true,
    description: '只快照白名单里的键和值，不碰整个注册表。',
  },
  hosts: {
    label: 'hosts 文件',
    restorable: true,
    description: '记录 hosts 全文；恢复前会先备份当前文件。',
  },
  envUser: {
    label: '用户环境变量',
    restorable: true,
    description: '当前用户的环境变量，可逐项恢复。',
  },
  envMachine: {
    label: '系统环境变量',
    restorable: false,
    description: '只读；改它通常需要管理员权限，也不在自动恢复范围。',
  },
  services: {
    label: '服务',
    restorable: false,
    description: '只读；记录名称、显示名、状态和启动类型。',
  },
  firewall: {
    label: '防火墙规则',
    restorable: false,
    description: '只读；记录规则名、方向、动作、启用状态和配置文件。',
  },
  scheduledTasks: {
    label: '计划任务',
    restorable: false,
    description: '只读；记录任务路径、名称和状态。',
  },
}

export const RESTORABLE_CATEGORIES = Object.keys(CATEGORY_META).filter(
  (key) => CATEGORY_META[key].restorable,
)

export const ALL_CATEGORIES = Object.keys(CATEGORY_META)

export const DEFAULT_REGISTRY_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  'HKCU\\Control Panel\\Desktop',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
]

export const DEFAULT_SETTINGS = {
  registryKeys: DEFAULT_REGISTRY_KEYS.slice(),
  includeHosts: true,
  includeEnvUser: true,
  includeEnvMachine: true,
  includeServices: true,
  includeFirewall: true,
  includeScheduledTasks: true,
  maxSnapshots: 30,
  keepDays: 30,
  diffMaxItems: 200,
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 只接受 HKCU\ 或 HKLM\ 开头、没有通配符和 .. 的键。
 * 返回规范化后的键；不合法返回 null。
 */
export function normalizeRegistryKey(value) {
  if (typeof value !== 'string') return null
  let key = value.trim().replace(/\//g, '\\').replace(/\\+$/g, '')
  if (key === '' || key.length > 240) return null
  if (!/^(HKCU|HKLM)\\/i.test(key)) return null
  if (/[*?]/.test(key) || key.includes('..')) return null
  const parts = key.split('\\')
  const hive = parts[0].toUpperCase()
  const sub = parts.slice(1).join('\\').trim()
  if (sub === '') return null
  return hive + '\\' + sub
}

export function normalizeRegistryKeys(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const key = normalizeRegistryKey(item)
    if (key === null) continue
    const lower = key.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(key)
  }
  return out
}

export function normalizeSettings(input) {
  const value = input && typeof input === 'object' ? input : {}
  const registryKeys =
    value.registryKeys === undefined
      ? DEFAULT_SETTINGS.registryKeys.slice()
      : normalizeRegistryKeys(value.registryKeys)

  return {
    registryKeys,
    includeHosts: pickBool(value.includeHosts, DEFAULT_SETTINGS.includeHosts),
    includeEnvUser: pickBool(value.includeEnvUser, DEFAULT_SETTINGS.includeEnvUser),
    includeEnvMachine: pickBool(value.includeEnvMachine, DEFAULT_SETTINGS.includeEnvMachine),
    includeServices: pickBool(value.includeServices, DEFAULT_SETTINGS.includeServices),
    includeFirewall: pickBool(value.includeFirewall, DEFAULT_SETTINGS.includeFirewall),
    includeScheduledTasks: pickBool(
      value.includeScheduledTasks,
      DEFAULT_SETTINGS.includeScheduledTasks,
    ),
    maxSnapshots: clampInt(value.maxSnapshots, DEFAULT_SETTINGS.maxSnapshots, 1, 100),
    keepDays: clampInt(value.keepDays, DEFAULT_SETTINGS.keepDays, 1, 365),
    diffMaxItems: clampInt(value.diffMaxItems, DEFAULT_SETTINGS.diffMaxItems, 20, 2000),
  }
}

export function makeSnapshotId(date, suffix) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp =
    String(d.getUTCFullYear()) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    '-' +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  const tail =
    typeof suffix === 'string' && /^[a-z0-9]{4,8}$/.test(suffix)
      ? suffix
      : Math.random().toString(36).slice(2, 6)
  return 'snap-' + stamp + '-' + tail
}

export function isValidSnapshotId(value) {
  return typeof value === 'string' && /^snap-[a-z0-9-]{6,64}$/.test(value)
}

export function cleanLabel(value) {
  if (typeof value !== 'string') return '手动快照'
  const label = value.replace(/\s+/g, ' ').trim().slice(0, 80)
  return label === '' ? '手动快照' : label
}

export function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('快照内容为空。')
  if (snapshot.version !== 1) throw new Error('不支持的快照版本：' + String(snapshot.version))
  if (!isValidSnapshotId(snapshot.id)) throw new Error('快照 ID 不合法。')
  if (!snapshot.categories || typeof snapshot.categories !== 'object') {
    throw new Error('快照缺少 categories。')
  }
  return snapshot
}

export function snapshotSummary(snapshot) {
  const categories = snapshot && snapshot.categories ? snapshot.categories : {}
  const counts = snapshot && snapshot.counts ? snapshot.counts : countCategories(categories)
  return {
    id: snapshot.id,
    label: snapshot.label || '',
    createdAt: snapshot.createdAt || '',
    host: snapshot.host || '',
    platform: snapshot.platform || '',
    counts,
    settings: snapshot.settings || null,
  }
}

export function countCategories(categories) {
  const c = categories || {}
  const registryKeys = c.registry && c.registry.keys ? c.registry.keys : {}
  let registryValues = 0
  for (const entry of Object.values(registryKeys)) {
    if (entry && Array.isArray(entry.values)) registryValues += entry.values.length
  }
  const hostsContent = c.hosts && typeof c.hosts.content === 'string' ? c.hosts.content : ''
  return {
    registryKeys: Object.keys(registryKeys).length,
    registryValues,
    hostsLines: hostsContent === '' ? 0 : hostsContent.split(/\r?\n/).length,
    envUser: c.envUser && Array.isArray(c.envUser.values) ? c.envUser.values.length : 0,
    envMachine:
      c.envMachine && Array.isArray(c.envMachine.values) ? c.envMachine.values.length : 0,
    services: c.services && Array.isArray(c.services.items) ? c.services.items.length : 0,
    firewall: c.firewall && Array.isArray(c.firewall.items) ? c.firewall.items.length : 0,
    scheduledTasks:
      c.scheduledTasks && Array.isArray(c.scheduledTasks.items)
        ? c.scheduledTasks.items.length
        : 0,
  }
}

function pairMap(items, keyFn) {
  const map = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    map.set(keyFn(item), item)
  }
  return map
}

function unionKeys(a, b) {
  const set = new Set()
  for (const key of a) set.add(key)
  for (const key of b) set.add(key)
  return Array.from(set)
}

function linesOf(value) {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function changedFields(a, b, fields) {
  const out = []
  for (const field of fields) {
    if (JSON.stringify(a ? a[field] : undefined) !== JSON.stringify(b ? b[field] : undefined)) {
      out.push(field)
    }
  }
  return out
}

/**
 * 比较两个快照。默认只输出变化名称，不输出环境变量的值。
 */
export function diffSnapshots(from, to, options = {}) {
  const maxItems = clampInt(options.maxItems, 200, 20, 2000)
  const summary = {}
  for (const category of ALL_CATEGORIES) {
    summary[category] = { added: 0, removed: 0, changed: 0 }
  }
  const changes = []
  let totalChanges = 0

  function add(category, kind, key, detail) {
    summary[category][kind] += 1
    totalChanges += 1
    if (changes.length < maxItems) {
      changes.push({ category, kind, key, detail: detail || '' })
    }
  }

  // 注册表：按白名单键逐值比较。
  const fromKeys = (from.categories && from.categories.registry && from.categories.registry.keys) || {}
  const toKeys = (to.categories && to.categories.registry && to.categories.registry.keys) || {}
  for (const key of unionKeys(Object.keys(fromKeys), Object.keys(toKeys))) {
    const a = fromKeys[key]
    const b = toKeys[key]
    if (!a) {
      add('registry', 'added', key, '整个键')
      continue
    }
    if (!b) {
      add('registry', 'removed', key, '整个键')
      continue
    }
    if (Boolean(a.exists) !== Boolean(b.exists)) {
      add('registry', 'changed', key, '存在状态')
      continue
    }
    if (!a.exists && !b.exists) continue
    const av = pairMap(a.values, (item) => item.name)
    const bv = pairMap(b.values, (item) => item.name)
    for (const name of unionKeys(Array.from(av.keys()), Array.from(bv.keys()))) {
      const label = name === '' ? '(默认值)' : name
      if (!av.has(name)) add('registry', 'added', key, label)
      else if (!bv.has(name)) add('registry', 'removed', key, label)
      else if (JSON.stringify(av.get(name)) !== JSON.stringify(bv.get(name))) {
        add('registry', 'changed', key, label)
      }
    }
  }

  // hosts：按非空行做多重集合比较，忽略顺序。
  const fromHosts = (from.categories && from.categories.hosts) || {}
  const toHosts = (to.categories && to.categories.hosts) || {}
  if (Boolean(fromHosts.exists) !== Boolean(toHosts.exists)) {
    add('hosts', 'changed', 'hosts', '存在状态')
  }
  const fromLines = linesOf(fromHosts.content)
  const toLines = linesOf(toHosts.content)
  const fromCount = new Map()
  for (const line of fromLines) fromCount.set(line, (fromCount.get(line) || 0) + 1)
  for (const line of toLines) {
    const left = fromCount.get(line) || 0
    if (left === 0) add('hosts', 'added', line, '行')
    else fromCount.set(line, left - 1)
  }
  for (const [line, left] of fromCount) {
    for (let i = 0; i < left; i += 1) add('hosts', 'removed', line, '行')
  }

  // 环境变量：只比较名字和值，不把值写进 diff 结果。
  for (const category of ['envUser', 'envMachine']) {
    const aEnv = (from.categories && from.categories[category]) || {}
    const bEnv = (to.categories && to.categories[category]) || {}
    const av = pairMap(aEnv.values, (item) => item.name)
    const bv = pairMap(bEnv.values, (item) => item.name)
    for (const name of unionKeys(Array.from(av.keys()), Array.from(bv.keys()))) {
      if (!av.has(name)) add(category, 'added', name, '变量')
      else if (!bv.has(name)) add(category, 'removed', name, '变量')
      else if (JSON.stringify(av.get(name).value) !== JSON.stringify(bv.get(name).value)) {
        add(category, 'changed', name, '值变化')
      }
    }
  }

  // 服务。
  const aServices = (from.categories && from.categories.services) || {}
  const bServices = (to.categories && to.categories.services) || {}
  const avServices = pairMap(aServices.items, (item) => item.name)
  const bvServices = pairMap(bServices.items, (item) => item.name)
  for (const name of unionKeys(Array.from(avServices.keys()), Array.from(bvServices.keys()))) {
    if (!avServices.has(name)) add('services', 'added', name, '服务')
    else if (!bvServices.has(name)) add('services', 'removed', name, '服务')
    else {
      const fields = changedFields(avServices.get(name), bvServices.get(name), [
        'status',
        'startType',
      ])
      if (fields.length > 0) add('services', 'changed', name, fields.join(', '))
    }
  }

  // 防火墙。
  const aFw = (from.categories && from.categories.firewall) || {}
  const bFw = (to.categories && to.categories.firewall) || {}
  const avFw = pairMap(aFw.items, (item) => item.name)
  const bvFw = pairMap(bFw.items, (item) => item.name)
  for (const name of unionKeys(Array.from(avFw.keys()), Array.from(bvFw.keys()))) {
    if (!avFw.has(name)) add('firewall', 'added', name, '规则')
    else if (!bvFw.has(name)) add('firewall', 'removed', name, '规则')
    else {
      const fields = changedFields(avFw.get(name), bvFw.get(name), [
        'enabled',
        'direction',
        'action',
        'profile',
      ])
      if (fields.length > 0) add('firewall', 'changed', name, fields.join(', '))
    }
  }

  // 计划任务。
  const aTasks = (from.categories && from.categories.scheduledTasks) || {}
  const bTasks = (to.categories && to.categories.scheduledTasks) || {}
  const taskKey = (item) => String(item.path || '') + String(item.name || '')
  const avTasks = pairMap(aTasks.items, taskKey)
  const bvTasks = pairMap(bTasks.items, taskKey)
  for (const key of unionKeys(Array.from(avTasks.keys()), Array.from(bvTasks.keys()))) {
    if (!avTasks.has(key)) add('scheduledTasks', 'added', key, '任务')
    else if (!bvTasks.has(key)) add('scheduledTasks', 'removed', key, '任务')
    else {
      const fields = changedFields(avTasks.get(key), bvTasks.get(key), ['state'])
      if (fields.length > 0) add('scheduledTasks', 'changed', key, fields.join(', '))
    }
  }

  return {
    from: snapshotSummary(from),
    to: snapshotSummary(to),
    summary,
    changes,
    totalChanges,
    truncated: totalChanges > changes.length,
  }
}

export function normalizeRestore(args) {
  const value = args && typeof args === 'object' ? args : {}
  if (!isValidSnapshotId(value.id)) {
    return { ok: false, error: '需要 system_snapshot 返回的快照 ID。' }
  }
  if (value.confirm !== true) {
    return { ok: false, error: '恢复必须显式传 confirm:true。' }
  }
  const requested =
    Array.isArray(value.categories) && value.categories.length > 0
      ? value.categories
      : RESTORABLE_CATEGORIES
  const categories = []
  for (const item of requested) {
    if (typeof item !== 'string' || !CATEGORY_META[item]) {
      return { ok: false, error: '未知的快照类别：' + String(item) }
    }
    if (!CATEGORY_META[item].restorable) {
      return {
        ok: false,
        error: '只读类别不能恢复：' + CATEGORY_META[item].label + '。只支持注册表、hosts、用户环境变量。',
      }
    }
    if (!categories.includes(item)) categories.push(item)
  }
  return { ok: true, value: { id: value.id, confirm: true, categories } }
}

export function describeDiff(diff) {
  if (!diff || !diff.summary) return '没有差异。'
  const lines = []
  for (const category of ALL_CATEGORIES) {
    const s = diff.summary[category]
    if (!s) continue
    const total = s.added + s.removed + s.changed
    if (total === 0) continue
    lines.push(
      '- ' +
        CATEGORY_META[category].label +
        '：新增 ' +
        s.added +
        '，删除 ' +
        s.removed +
        '，改动 ' +
        s.changed,
    )
  }
  if (lines.length === 0) return '没有差异。'
  return '差异汇总：\n' + lines.join('\n')
}

export function categoryMetaList() {
  return ALL_CATEGORIES.map((id) => ({
    id,
    label: CATEGORY_META[id].label,
    description: CATEGORY_META[id].description,
    restorable: CATEGORY_META[id].restorable,
  }))
}
