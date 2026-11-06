/**
 * dsh-system-snapshot 宿主半身。
 *
 * 工具：system_snapshot / system_diff / system_restore
 * 设置页：/system-snapshot/settings
 *
 * 只快照白名单；服务、防火墙、计划任务、系统环境变量永远只读。
 * 恢复只覆盖注册表、hosts、用户环境变量，且必须先 confirm:true，恢复前自动备份。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RESTORABLE_CATEGORIES,
  categoryMetaList,
  describeDiff,
  normalizeSettings,
} from './core.js'
import { createPowerShellRunner } from './powershell.js'
import { createService } from './service.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, 'snapshot.ps1')

export const name = 'system-snapshot'
export const inject = ['tools', 'systemPrompt', 'webServer']

function dshHome() {
  return (
    process.env.DSH_HOME ||
    join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
  )
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(raw))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function errorText(error) {
  return String(error && error.message ? error.message : error)
}

function countLine(counts) {
  const c = counts || {}
  return (
    '注册表 ' +
    String(c.registryKeys || 0) +
    ' 键/' +
    String(c.registryValues || 0) +
    ' 值，hosts ' +
    String(c.hostsLines || 0) +
    ' 行，用户环境变量 ' +
    String(c.envUser || 0) +
    '，服务 ' +
    String(c.services || 0) +
    '，防火墙 ' +
    String(c.firewall || 0) +
    '，计划任务 ' +
    String(c.scheduledTasks || 0)
  )
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir
    ? resolve(config.dataDir)
    : join(dshHome(), 'data', 'system-snapshot')

  const service = createService({
    dataDir,
    runPowerShell: createPowerShellRunner({
      scriptPath: SCRIPT_PATH,
      tempDir: join(dataDir, 'tmp'),
      timeoutMs: 180000,
    }),
    config: normalizeSettings(config),
  })

  const snapshotTool = {
    name: 'system_snapshot',
    description:
      '创建或列出本机系统快照。只采集白名单：指定的注册表键、hosts、用户/系统环境变量、服务、防火墙、计划任务。' +
      '服务、防火墙、计划任务、系统环境变量只读。快照存 DSH_HOME/data/system-snapshot，不会上传。' +
      '在改系统设置前先建一份，之后用 system_diff 看变化。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list'],
          description: 'create 建快照；list 列出已有快照。',
        },
        label: {
          type: 'string',
          description: '可选标签，最多 80 字；例如“改代理前”。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          snapshot: { type: 'object', additionalProperties: true },
          snapshots: { type: 'array', items: { type: 'object', additionalProperties: true } },
          message: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        return [{ type: 'text', text: result.message || result.error || '系统快照完成。' }]
      },
    },
    timeoutMs: 240000,
    async execute(rawArgs) {
      try {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        if (args.action === 'list') {
          const snapshots = service.list()
          if (snapshots.length === 0) {
            return { ok: true, snapshots: [], message: '还没有系统快照。' }
          }
          const lines = snapshots.map(
            (item) =>
              '- ' +
              item.id +
              '  ' +
              (item.label || '手动快照') +
              '  ' +
              item.createdAt +
              '\n  ' +
              countLine(item.counts),
          )
          return {
            ok: true,
            snapshots,
            message: '系统快照（' + String(snapshots.length) + ' 份）：\n' + lines.join('\n'),
          }
        }
        if (args.action === 'create') {
          const snapshot = await service.create(args.label)
          return {
            ok: true,
            snapshot,
            message:
              '已创建快照 ' +
              snapshot.id +
              '（' +
              (snapshot.label || '手动快照') +
              '）。\n' +
              countLine(snapshot.counts),
          }
        }
        return { ok: false, error: 'action 只能是 create 或 list。' }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }

  const diffTool = {
    name: 'system_diff',
    description:
      '比较一份系统快照与当前状态（默认）或另一份快照，列出新增、删除、改动。' +
      '只输出变化名称和摘要，不输出环境变量的值。白名单外的东西不比较。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '作为基准的快照 ID。' },
        compareTo: {
          type: 'string',
          description: '对比目标：current（默认，现采一份当前状态）或另一个快照 ID。',
        },
        maxItems: {
          type: 'integer',
          minimum: 20,
          maximum: 2000,
          description: '最多列出多少条变化，默认 200。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          diff: { type: 'object', additionalProperties: true },
          message: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        return [{ type: 'text', text: result.message || result.error || '比较完成。' }]
      },
    },
    timeoutMs: 240000,
    async execute(rawArgs) {
      try {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const diff = await service.diff(args.id, args.compareTo, args.maxItems)
        return {
          ok: true,
          diff,
          message: describeDiff(diff) + (diff.totalChanges > diff.changes.length ? '\n（只列出前 ' + String(diff.changes.length) + ' 条）' : ''),
        }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }

  const restoreTool = {
    name: 'system_restore',
    description:
      '把注册表白名单键、hosts、用户环境变量恢复到某份快照。必须先传 confirm:true，且只能由用户明确要求后执行。' +
      '恢复前会自动再建一份当前状态快照；服务、防火墙、计划任务、系统环境变量永远只读，不会被改。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要恢复到的快照 ID。' },
        confirm: {
          type: 'boolean',
          description: '必须显式为 true；缺少或为 false 都会拒绝。',
        },
        categories: {
          type: 'array',
          items: { type: 'string', enum: RESTORABLE_CATEGORIES },
          description: '只恢复这些类别；默认全部可恢复类别（注册表、hosts、用户环境变量）。',
        },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'object', additionalProperties: true },
          backup: { type: 'string' },
          restored: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          partial: { type: 'boolean' },
          message: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        return [{ type: 'text', text: result.message || result.error || '恢复完成。' }]
      },
    },
    timeoutMs: 300000,
    async execute(rawArgs) {
      try {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        const result = await service.restore(args)
        const lines = []
        lines.push('已恢复到快照 ' + result.target.id + '。')
        lines.push('恢复前备份：' + result.backup)
        lines.push('已恢复：' + (result.restored.length ? result.restored.join('；') : '无'))
        if (result.skipped.length) lines.push('跳过：' + result.skipped.join('；'))
        if (result.errors.length) lines.push('错误：' + result.errors.join('；'))
        if (result.partial) lines.push('注意：有部分项目恢复失败。')
        return { ...result, message: lines.join('\n') }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }

  ctx.tools.register(snapshotTool)
  ctx.tools.register(diffTool)
  ctx.tools.register(restoreTool)

  try {
    ctx.systemPrompt.section({
      name: 'tool:system-snapshot',
      order: 154,
      text:
        '改系统设置前，先用 system_snapshot 建立白名单快照；改完用 system_diff 对比。' +
        '服务、防火墙、计划任务、系统环境变量只读，不能恢复。system_restore 只覆盖注册表白名单、hosts、用户环境变量，' +
        '必须用户明确要求后才传 confirm:true；恢复前会自动备份。不要用本工具宣称能还原全系统。',
    })
  } catch (error) {
    console.warn('[system-snapshot] system prompt section unavailable:', error && error.message)
  }

  try {
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return

      webServer.register({
        kind: 'exact',
        path: '/system-snapshot/settings',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              settings: service.getSettings(),
              snapshots: service.list(),
              categories: categoryMetaList(),
              restorable: RESTORABLE_CATEGORIES,
              dataDir: service.paths.root,
            })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const raw = await readBody(req)
            const body = JSON.parse(raw || '{}')
            const patch = body && body.settings && typeof body.settings === 'object' ? body.settings : body
            const settings = service.saveSettings(patch)
            sendJson(res, 200, { ok: true, settings })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: errorText(error) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/system-snapshot/create',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const raw = await readBody(req)
            const body = JSON.parse(raw || '{}')
            const snapshot = await service.create(body && body.label)
            sendJson(res, 200, { ok: true, snapshot, snapshots: service.list() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: errorText(error) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/system-snapshot/diff',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const raw = await readBody(req)
            const body = JSON.parse(raw || '{}')
            const diff = await service.diff(body && body.id, body && body.compareTo, body && body.maxItems)
            sendJson(res, 200, { ok: true, diff })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: errorText(error) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/system-snapshot/restore',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const raw = await readBody(req)
            const body = JSON.parse(raw || '{}')
            const result = await service.restore(body || {})
            sendJson(res, 200, { ...result, snapshots: service.list() })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: errorText(error) })
          }
        },
      })
    })
  } catch (error) {
    console.warn('[system-snapshot] web settings unavailable:', error && error.message)
  }

  // 没有定时器；快照全部是显式调用，进程退出即可。
}
