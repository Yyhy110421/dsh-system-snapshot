import assert from 'node:assert/strict'
import {
  ALL_CATEGORIES,
  DEFAULT_REGISTRY_KEYS,
  RESTORABLE_CATEGORIES,
  assertSnapshot,
  categoryMetaList,
  cleanLabel,
  countCategories,
  describeDiff,
  diffSnapshots,
  isValidSnapshotId,
  makeSnapshotId,
  normalizeRegistryKey,
  normalizeRegistryKeys,
  normalizeRestore,
  normalizeSettings,
  snapshotSummary,
} from '../lib/core.js'

// 注册表键白名单：只收 HKCU/HKLM，拒绝通配符、越级和空键。
assert.equal(normalizeRegistryKey(' hkcu\\Software\\Test\\ '), 'HKCU\\Software\\Test')
assert.equal(normalizeRegistryKey('HKLM/SOFTWARE/Run'), 'HKLM\\SOFTWARE\\Run')
assert.equal(normalizeRegistryKey('HKEY_LOCAL_MACHINE\\SOFTWARE\\Run'), null)
assert.equal(normalizeRegistryKey('HKCU\\Software\\*'), null)
assert.equal(normalizeRegistryKey('HKCU\\Software\\..\\Run'), null)
assert.equal(normalizeRegistryKey('HKCU'), null)
assert.equal(normalizeRegistryKey('HKCU\\'), null)
assert.equal(normalizeRegistryKey(''), null)
assert.equal(normalizeRegistryKey(42), null)

const keys = normalizeRegistryKeys([
  'HKCU\\Software\\Test',
  'hkcu\\software\\test',
  'HKLM\\SOFTWARE\\Run',
  'bad',
])
assert.deepEqual(keys, ['HKCU\\Software\\Test', 'HKLM\\SOFTWARE\\Run'])
assert.deepEqual(normalizeRegistryKeys('HKCU\\A\nHKLM\\B'), ['HKCU\\A', 'HKLM\\B'])

// 设置：默认值、clamp、字符串白名单。
const defaults = normalizeSettings({})
assert.deepEqual(defaults.registryKeys, DEFAULT_REGISTRY_KEYS)
assert.equal(defaults.includeHosts, true)
assert.equal(defaults.maxSnapshots, 30)
assert.equal(normalizeSettings({ maxSnapshots: 0 }).maxSnapshots, 1)
assert.equal(normalizeSettings({ maxSnapshots: 999 }).maxSnapshots, 100)
assert.equal(normalizeSettings({ keepDays: 999 }).keepDays, 365)
assert.equal(normalizeSettings({ diffMaxItems: 1 }).diffMaxItems, 20)
assert.deepEqual(normalizeSettings({ registryKeys: 'HKCU\\Only' }).registryKeys, ['HKCU\\Only'])
assert.equal(normalizeSettings({ includeServices: false }).includeServices, false)

// ID 与标签。
assert.equal(makeSnapshotId(new Date('2026-11-06T04:05:06Z'), 'abcd'), 'snap-20261106-040506-abcd')
assert.equal(isValidSnapshotId('snap-20261106-040506-abcd'), true)
assert.equal(isValidSnapshotId('snap-x'), false)
assert.equal(isValidSnapshotId('../../etc/passwd'), false)
assert.equal(cleanLabel('  改代理  \n 前 '), '改代理 前')
assert.equal(cleanLabel('   '), '手动快照')
assert.equal(cleanLabel(null), '手动快照')

// 快照结构校验。
const base = {
  version: 1,
  id: 'snap-20261106-040506-abcd',
  label: '测试',
  createdAt: '2026-11-06T04:05:06.000Z',
  host: 'test-host',
  platform: 'win32',
  settings: defaults,
  categories: {
    registry: {
      keys: {
        'HKCU\\A': {
          exists: true,
          values: [
            { name: '', kind: 'REG_SZ', value: 'x' },
            { name: 'Keep', kind: 'REG_SZ', value: '1' },
          ],
        },
      },
    },
    hosts: { path: 'C:\\hosts', exists: true, sha256: 'a', content: '127.0.0.1 a' },
    envUser: { values: [{ name: 'A', value: '1' }] },
    envMachine: { values: [] },
    services: { items: [] },
    firewall: { items: [] },
    scheduledTasks: { items: [] },
  },
}
base.counts = countCategories(base.categories)
assert.equal(assertSnapshot(base), base)
assert.throws(() => assertSnapshot({ ...base, version: 2 }), /快照版本/)
assert.throws(() => assertSnapshot({ ...base, categories: null }), /categories/)
assert.equal(snapshotSummary(base).counts.registryValues, 2)
assert.equal(snapshotSummary(base).settings.maxSnapshots, 30)
assert.equal(countCategories(base.categories).hostsLines, 1)

// 差异：注册表新增/删除/改动、hosts 新增、环境变量改动。
const changed = JSON.parse(JSON.stringify(base))
changed.categories.registry.keys['HKCU\\A'].values = [
  { name: '', kind: 'REG_SZ', value: 'y' },
  { name: 'New', kind: 'REG_SZ', value: '2' },
]
changed.categories.hosts.content = '127.0.0.1 a\n127.0.0.1 b'
changed.categories.envUser.values = [{ name: 'A', value: '2' }]
const diff = diffSnapshots(base, changed, { maxItems: 200 })
assert.equal(diff.totalChanges, 5)
assert.equal(diff.summary.registry.changed, 1)
assert.equal(diff.summary.registry.added, 1)
assert.equal(diff.summary.registry.removed, 1)
assert.equal(diff.summary.hosts.added, 1)
assert.equal(diff.summary.envUser.changed, 1)
assert.equal(diff.changes.length, 5)
assert.equal(diff.truncated, false)
assert.ok(describeDiff(diff).includes('注册表'))
assert.ok(describeDiff(diff).includes('用户环境变量'))
assert.ok(!JSON.stringify(diff.changes).includes('"value"'), '差异结果不能带环境变量的值')

// 截断。
const truncated = diffSnapshots(base, changed, { maxItems: 20 })
assert.equal(truncated.changes.length <= 20, true)
assert.equal(truncated.totalChanges, 5)

// 恢复范围：必须 confirm，只允许三类。
const id = base.id
assert.equal(normalizeRestore({ id }).ok, false)
assert.equal(normalizeRestore({ id, confirm: false }).ok, false)
assert.deepEqual(normalizeRestore({ id, confirm: true }).value.categories, RESTORABLE_CATEGORIES)
assert.deepEqual(normalizeRestore({ id, confirm: true, categories: ['registry'] }).value.categories, ['registry'])
assert.equal(normalizeRestore({ id, confirm: true, categories: ['envMachine'] }).ok, false)
assert.equal(normalizeRestore({ id, confirm: true, categories: ['nope'] }).ok, false)
assert.equal(normalizeRestore({ id: 'nope', confirm: true }).ok, false)

// 类别清单。
assert.equal(ALL_CATEGORIES.length, 7)
assert.equal(RESTORABLE_CATEGORIES.length, 3)
const meta = categoryMetaList()
assert.equal(meta.length, 7)
assert.equal(meta.filter((item) => item.restorable).length, 3)

console.log('manual tests passed')
