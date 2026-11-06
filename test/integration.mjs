import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPowerShellRunner } from '../lib/powershell.js'
import { createService } from '../lib/service.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DATA_DIR = 'E:\\DSH\\temp\\system-snapshot-integration'
const KEY = 'HKCU\\Software\\DSH-SystemSnapshot-Test'

function reg(args) {
  return execFileSync('reg.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function setValue(name, value, type = 'REG_SZ') {
  const args = ['add', KEY]
  if (name === '') args.push('/ve')
  else args.push('/v', name)
  args.push('/t', type, '/d', String(value), '/f')
  reg(args)
}

function deleteValue(name) {
  const args = ['delete', KEY]
  if (name === '') args.push('/ve')
  else args.push('/v', name)
  args.push('/f')
  try {
    reg(args)
  } catch {
    // 值本来就不存在，忽略。
  }
}

rmSync(DATA_DIR, { recursive: true, force: true })

const service = createService({
  dataDir: DATA_DIR,
  runPowerShell: createPowerShellRunner({
    scriptPath: join(ROOT, 'lib', 'snapshot.ps1'),
    tempDir: join(DATA_DIR, 'tmp'),
    timeoutMs: 180000,
  }),
  config: {
    registryKeys: [KEY],
    includeHosts: false,
    includeEnvUser: false,
    includeEnvMachine: false,
    includeServices: false,
    includeFirewall: false,
    includeScheduledTasks: false,
  },
})

try {
  try {
    reg(['delete', KEY, '/f'])
  } catch {
    // 测试键本来就不存在。
  }
  setValue('', 'default-value')
  setValue('Alpha', 'hello')
  setValue('Count', 7, 'REG_DWORD')
  deleteValue('Extra')

  const snapshot = await service.create('集成测试')
  assert.match(snapshot.id, /^snap-/)
  assert.equal(snapshot.counts.registryKeys, 1)
  assert.equal(snapshot.counts.registryValues, 3)
  assert.equal(service.list().length, 1)
  assert.equal(service.get(snapshot.id).id, snapshot.id)

  setValue('Alpha', 'changed')
  setValue('Extra', 'should-be-removed')
  deleteValue('Count')

  const diff = await service.diff(snapshot.id, 'current')
  assert.ok(diff.totalChanges >= 3, '至少应有改动/新增/删除三类变化')
  assert.ok(diff.summary.registry.changed >= 1)
  assert.ok(diff.summary.registry.added >= 1)
  assert.ok(diff.summary.registry.removed >= 1)
  assert.ok(diff.changes.every((item) => item.category === 'registry'))

  const restored = await service.restore({
    id: snapshot.id,
    confirm: true,
    categories: ['registry'],
  })
  assert.equal(restored.ok, true)
  assert.equal(restored.partial, false)
  assert.equal(restored.restored.length > 0, true)
  assert.equal(restored.backup.startsWith('snap-'), true)
  assert.equal(service.list().length, 2)

  const after = await service.diff(snapshot.id, 'current')
  assert.equal(after.totalChanges, 0)

  const alpha = reg(['query', KEY, '/v', 'Alpha'])
  assert.ok(alpha.includes('hello'))
  const count = reg(['query', KEY, '/v', 'Count'])
  assert.ok(count.includes('0x7'))
  assert.throws(() => reg(['query', KEY, '/v', 'Extra']))

  console.log('integration tests passed')
} finally {
  try {
    reg(['delete', KEY, '/f'])
  } catch {
    // 测试键可能已经被删掉。
  }
  rmSync(DATA_DIR, { recursive: true, force: true })
}
