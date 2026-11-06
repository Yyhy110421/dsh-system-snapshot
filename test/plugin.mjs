import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
    },
    end(text) {
      this.body = String(text || '')
    },
  }
}

function makeReq(method) {
  const req = new EventEmitter()
  req.method = method
  return req
}

async function request(route, method, body) {
  const req = makeReq(method)
  const res = makeRes()
  const pending = route.handler(req, res)
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  }
  await pending
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

const dataDir = mkdtempSync('E:\\DSH\\temp\\system-snapshot-plugin-')
const tools = new Map()
const routes = new Map()
const sections = []
const ctx = {
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
    },
  },
  inject(deps, fn) {
    if (deps.includes('webServer')) {
      fn({
        webServer: {
          register(route) {
            routes.set(route.path, route)
          },
        },
      })
    }
  },
  on() {},
}

try {
  apply(ctx, {
    dataDir,
    registryKeys: ['HKCU\\Software\\DSH-SystemSnapshot-Test'],
    includeHosts: false,
    includeEnvUser: false,
    includeEnvMachine: false,
    includeServices: false,
    includeFirewall: false,
    includeScheduledTasks: false,
  })

  assert.deepEqual([...tools.keys()].sort(), ['system_diff', 'system_restore', 'system_snapshot'])
  assert.deepEqual([...routes.keys()].sort(), [
    '/system-snapshot/create',
    '/system-snapshot/diff',
    '/system-snapshot/restore',
    '/system-snapshot/settings',
  ])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:system-snapshot')
  assert.equal(sections[0].order, 154)
  assert.ok(sections[0].text.includes('只读'))

  const listed = await tools.get('system_snapshot').execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.snapshots, [])
  assert.ok(listed.message.includes('还没有'))

  const badAction = await tools.get('system_snapshot').execute({ action: 'nope' })
  assert.equal(badAction.ok, false)

  const badDiff = await tools.get('system_diff').execute({ id: 'snap-20261106-040506-abcd' })
  assert.equal(badDiff.ok, false)
  assert.ok(badDiff.error.includes('找不到快照'))

  const noConfirm = await tools.get('system_restore').execute({
    id: 'snap-20261106-040506-abcd',
    confirm: false,
  })
  assert.equal(noConfirm.ok, false)
  assert.ok(noConfirm.error.includes('confirm:true'))

  const settingsGet = await request(routes.get('/system-snapshot/settings'), 'GET')
  assert.equal(settingsGet.status, 200)
  assert.equal(settingsGet.json.ok, true)
  assert.equal(settingsGet.json.settings.registryKeys.length, 1)
  assert.equal(settingsGet.json.settings.includeServices, false)
  assert.equal(settingsGet.json.restorable.length, 3)
  assert.equal(settingsGet.json.categories.length, 7)
  assert.equal(settingsGet.json.dataDir, dataDir)

  const settingsPost = await request(routes.get('/system-snapshot/settings'), 'POST', {
    settings: {
      maxSnapshots: 5,
      keepDays: 2,
      diffMaxItems: 50,
      includeServices: true,
      registryKeys: ['HKCU\\Software\\DSH-SystemSnapshot-Test', 'bad'],
    },
  })
  assert.equal(settingsPost.status, 200)
  assert.equal(settingsPost.json.settings.maxSnapshots, 5)
  assert.equal(settingsPost.json.settings.keepDays, 2)
  assert.equal(settingsPost.json.settings.diffMaxItems, 50)
  assert.equal(settingsPost.json.settings.includeServices, true)
  assert.deepEqual(settingsPost.json.settings.registryKeys, [
    'HKCU\\Software\\DSH-SystemSnapshot-Test',
  ])
  const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
  assert.equal(saved.maxSnapshots, 5)

  const methodNotAllowed = await request(routes.get('/system-snapshot/create'), 'GET')
  assert.equal(methodNotAllowed.status, 405)
  assert.equal(methodNotAllowed.json.ok, false)

  const badRestore = await request(routes.get('/system-snapshot/restore'), 'POST', {
    id: 'snap-20261106-040506-abcd',
    confirm: false,
  })
  assert.equal(badRestore.status, 400)
  assert.equal(badRestore.json.ok, false)

  console.log('plugin tests passed')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
