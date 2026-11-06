/**
 * dsh-system-snapshot 浏览器半身：设置 → 系统快照。
 *
 * 只展示白名单快照的摘要和变化名称，不展示环境变量的值。
 * 恢复只允许注册表、hosts、用户环境变量；服务、防火墙、计划任务、系统环境变量只读。
 */
window.__ModuleLoader__.load({
  id: 'dsh-system-snapshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'system-snapshot'
    const RESTORE_LABELS = { registry: '注册表', hosts: 'hosts', envUser: '用户环境变量' }

    const card = {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: '4px 2px 24px',
      maxWidth: 840,
      fontSize: 13,
      lineHeight: 1.55,
      color: 'inherit',
    }
    const section = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '12px 14px',
      border: '1px solid rgba(127,127,127,0.26)',
      borderRadius: 10,
      background: 'rgba(127,127,127,0.035)',
    }
    const row = { display: 'flex', flexDirection: 'column', gap: 6 }
    const label = { fontWeight: 600, opacity: 0.92 }
    const hint = { fontSize: 12, opacity: 0.66 }
    const control = {
      minHeight: 32,
      padding: '6px 8px',
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid rgba(127,127,127,0.4)',
      borderRadius: 8,
      boxSizing: 'border-box',
    }
    const area = { ...control, width: '100%', minHeight: 92, resize: 'vertical' }
    const button = {
      padding: '6px 14px',
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(127,127,127,0.12)',
      border: '1px solid rgba(127,127,127,0.42)',
      borderRadius: 8,
      cursor: 'pointer',
    }
    const primary = {
      ...button,
      background: 'rgba(64,120,255,0.15)',
      border: '1px solid rgba(64,120,255,0.5)',
      fontWeight: 600,
    }
    const danger = {
      ...button,
      background: 'rgba(220,70,70,0.12)',
      border: '1px solid rgba(220,70,70,0.48)',
      color: 'inherit',
    }
    const disabled = { ...button, opacity: 0.5, cursor: 'not-allowed' }
    const badge = {
      display: 'inline-block',
      padding: '0 6px',
      marginLeft: 6,
      fontSize: 11,
      lineHeight: '17px',
      border: '1px solid rgba(127,127,127,0.35)',
      borderRadius: 999,
      opacity: 0.72,
      verticalAlign: 'middle',
    }
    const snapshotItem = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '10px 12px',
      border: '1px solid rgba(127,127,127,0.24)',
      borderRadius: 9,
      background: 'rgba(127,127,127,0.045)',
    }
    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace',
      fontSize: 11,
      opacity: 0.8,
      wordBreak: 'break-all',
    }
    const grid = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
      gap: 8,
    }
    const checkItem = {
      display: 'flex',
      gap: 8,
      alignItems: 'flex-start',
      padding: '7px 9px',
      border: '1px solid rgba(127,127,127,0.24)',
      borderRadius: 8,
      cursor: 'pointer',
    }
    const changeItem = {
      padding: '5px 0',
      borderTop: '1px solid rgba(127,127,127,0.16)',
      fontSize: 12,
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    function countText(counts) {
      const c = counts || {}
      return (
        '注册表 ' +
        String(c.registryKeys || 0) +
        ' 键/' +
        String(c.registryValues || 0) +
        ' 值 · hosts ' +
        String(c.hostsLines || 0) +
        ' 行 · 用户环境变量 ' +
        String(c.envUser || 0) +
        ' · 服务 ' +
        String(c.services || 0) +
        ' · 防火墙 ' +
        String(c.firewall || 0) +
        ' · 计划任务 ' +
        String(c.scheduledTasks || 0)
      )
    }

    function mergeSettings(previous, next) {
      const value = next && typeof next === 'object' ? next : {}
      return {
        registryKeys: Array.isArray(value.registryKeys)
          ? value.registryKeys
          : Array.isArray(previous.registryKeys)
            ? previous.registryKeys
            : [],
        includeHosts: value.includeHosts !== false,
        includeEnvUser: value.includeEnvUser !== false,
        includeEnvMachine: value.includeEnvMachine !== false,
        includeServices: value.includeServices !== false,
        includeFirewall: value.includeFirewall !== false,
        includeScheduledTasks: value.includeScheduledTasks !== false,
        maxSnapshots:
          typeof value.maxSnapshots === 'number' ? value.maxSnapshots : previous.maxSnapshots,
        keepDays: typeof value.keepDays === 'number' ? value.keepDays : previous.keepDays,
        diffMaxItems:
          typeof value.diffMaxItems === 'number' ? value.diffMaxItems : previous.diffMaxItems,
      }
    }

    async function request(url, options) {
      const response = await fetch(url, options)
      const body = await response.json().catch(() => null)
      if (!body || body.ok !== true) {
        throw new Error((body && body.error) || '请求失败（HTTP ' + response.status + '）')
      }
      return body
    }

    function Panel() {
      const [state, setState] = React.useState({
        loading: true,
        saving: false,
        creating: false,
        diffing: '',
        restoring: '',
        confirming: '',
        snapshots: [],
        categories: [],
        restorable: [],
        dataDir: '',
        label: '',
        settings: {
          registryKeys: [],
          includeHosts: true,
          includeEnvUser: true,
          includeEnvMachine: true,
          includeServices: true,
          includeFirewall: true,
          includeScheduledTasks: true,
          maxSnapshots: 30,
          keepDays: 30,
          diffMaxItems: 200,
        },
        restoreCategories: [],
        result: null,
        notice: '',
        error: '',
      })

      React.useEffect(() => {
        let alive = true
        request('/system-snapshot/settings')
          .then((body) => {
            if (!alive) return
            const restorable = Array.isArray(body.restorable) ? body.restorable : []
            setState((prev) => ({
              ...prev,
              loading: false,
              settings: mergeSettings(prev.settings, body.settings),
              snapshots: Array.isArray(body.snapshots) ? body.snapshots : [],
              categories: Array.isArray(body.categories) ? body.categories : [],
              restorable,
              dataDir: typeof body.dataDir === 'string' ? body.dataDir : '',
              restoreCategories: restorable.slice(),
            }))
          })
          .catch((error) => {
            if (alive) {
              setState((prev) => ({
                ...prev,
                loading: false,
                error: '读取设置失败：' + String(error && error.message ? error.message : error),
              }))
            }
          })
        return () => {
          alive = false
        }
      }, [])

      function updateSetting(field, value) {
        setState((prev) => ({ ...prev, settings: { ...prev.settings, [field]: value } }))
      }

      function toggleRestoreCategory(id) {
        setState((prev) => {
          const selected = new Set(prev.restoreCategories)
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
          return { ...prev, restoreCategories: [...selected] }
        })
      }

      async function save() {
        setState((prev) => ({ ...prev, saving: true, notice: '', error: '' }))
        try {
          const body = await request('/system-snapshot/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(state.settings),
          })
          setState((prev) => ({
            ...prev,
            saving: false,
            settings: mergeSettings(prev.settings, body.settings),
            notice: '设置已保存。',
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            saving: false,
            error: '保存失败：' + String(error && error.message ? error.message : error),
          }))
        }
      }

      async function createSnapshot() {
        setState((prev) => ({ ...prev, creating: true, notice: '', error: '' }))
        try {
          const body = await request('/system-snapshot/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: state.label.trim() || '手动快照' }),
          })
          setState((prev) => ({
            ...prev,
            creating: false,
            label: '',
            snapshots: Array.isArray(body.snapshots) ? body.snapshots : prev.snapshots,
            result: { kind: 'create', snapshot: body.snapshot },
            notice: '已创建快照 ' + (body.snapshot && body.snapshot.id ? body.snapshot.id : '') + '。',
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            creating: false,
            error: '创建失败：' + String(error && error.message ? error.message : error),
          }))
        }
      }

      async function diffSnapshot(id) {
        setState((prev) => ({ ...prev, diffing: id, notice: '', error: '' }))
        try {
          const body = await request('/system-snapshot/diff', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, compareTo: 'current' }),
          })
          setState((prev) => ({
            ...prev,
            diffing: '',
            result: { kind: 'diff', diff: body.diff },
            notice: '',
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            diffing: '',
            error: '比较失败：' + String(error && error.message ? error.message : error),
          }))
        }
      }

      async function restoreSnapshot(id) {
        if (!state.restoreCategories.length) {
          setState((prev) => ({ ...prev, error: '至少选择一个恢复范围。' }))
          return
        }
        setState((prev) => ({ ...prev, restoring: id, notice: '', error: '' }))
        try {
          const body = await request('/system-snapshot/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id,
              confirm: true,
              categories: state.restoreCategories,
            }),
          })
          setState((prev) => ({
            ...prev,
            restoring: '',
            confirming: '',
            snapshots: Array.isArray(body.snapshots) ? body.snapshots : prev.snapshots,
            result: { kind: 'restore', restore: body },
            notice: '恢复完成；恢复前已自动备份。',
          }))
        } catch (error) {
          setState((prev) => ({
            ...prev,
            restoring: '',
            error: '恢复失败：' + String(error && error.message ? error.message : error),
          }))
        }
      }

      const toggles = [
        { field: 'includeHosts', label: 'hosts 文件' },
        { field: 'includeEnvUser', label: '用户环境变量' },
        { field: 'includeEnvMachine', label: '系统环境变量', readOnly: true },
        { field: 'includeServices', label: '服务', readOnly: true },
        { field: 'includeFirewall', label: '防火墙规则', readOnly: true },
        { field: 'includeScheduledTasks', label: '计划任务', readOnly: true },
      ]

      const toggleItems = toggles.map((item) =>
        h(
          'label',
          { key: item.field, style: checkItem },
          h('input', {
            type: 'checkbox',
            checked: state.settings[item.field] !== false,
            onChange: (event) => updateSetting(item.field, event.target.checked),
          }),
          h(
            'span',
            null,
            item.label,
            item.readOnly ? h('span', { style: badge }, '只读') : null,
          ),
        ),
      )

      const restoreItems = state.restorable.map((id) =>
        h(
          'label',
          { key: id, style: checkItem },
          h('input', {
            type: 'checkbox',
            checked: state.restoreCategories.includes(id),
            onChange: () => toggleRestoreCategory(id),
          }),
          h('span', null, RESTORE_LABELS[id] || id),
        ),
      )

      const snapshotItems = state.snapshots.map((item) => {
        const isConfirming = state.confirming === item.id
        const busy = state.restoring === item.id
        return h(
          'div',
          { key: item.id, style: snapshotItem },
          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('strong', null, item.label || '手动快照'),
            h('span', { style: hint }, formatTime(item.createdAt)),
          ),
          h('div', { style: mono }, item.id),
          h('div', { style: hint }, countText(item.counts)),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 } },
            h(
              'button',
              {
                style: state.diffing === item.id ? disabled : button,
                disabled: state.diffing === item.id,
                onClick: () => diffSnapshot(item.id),
              },
              state.diffing === item.id ? '比较中…' : '与当前比较',
            ),
            isConfirming
              ? h(
                  'span',
                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h(
                    'button',
                    {
                      style: busy ? disabled : danger,
                      disabled: busy,
                      onClick: () => restoreSnapshot(item.id),
                    },
                    busy ? '恢复中…' : '确认恢复（先自动备份）',
                  ),
                  h(
                    'button',
                    { style: button, disabled: busy, onClick: () => setState((prev) => ({ ...prev, confirming: '' })) },
                    '取消',
                  ),
                )
              : h(
                  'button',
                  {
                    style: button,
                    onClick: () => setState((prev) => ({ ...prev, confirming: item.id, notice: '', error: '' })),
                  },
                  '恢复…',
                ),
          ),
        )
      })

      function diffView(diff) {
        if (!diff || !diff.summary) return h('div', { style: hint }, '没有差异。')
        const rows = []
        for (const category of state.categories) {
          const summary = diff.summary[category.id]
          if (!summary) continue
          const total = summary.added + summary.removed + summary.changed
          if (total === 0) continue
          rows.push(
            h(
              'div',
              { key: category.id, style: changeItem },
              h('strong', null, category.label),
              '：新增 ' + summary.added + '，删除 ' + summary.removed + '，改动 ' + summary.changed,
            ),
          )
        }
        if (rows.length === 0) return h('div', { style: hint }, '没有差异。')
        const changes = Array.isArray(diff.changes) ? diff.changes.slice(0, 40) : []
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          rows,
          changes.length > 0
            ? h(
                'div',
                { style: { marginTop: 8 } },
                h('div', { style: label }, '变化明细（前 ' + changes.length + ' 条）'),
                changes.map((change, index) =>
                  h(
                    'div',
                    { key: String(index), style: { ...changeItem, ...mono } },
                    String(change.kind === 'added' ? '＋' : change.kind === 'removed' ? '－' : '～') +
                      ' ' +
                      String(change.key || '') +
                      (change.detail ? '  ' + String(change.detail) : ''),
                  ),
                ),
              )
            : null,
          diff.truncated ? h('div', { style: hint }, '变化太多，只列出了一部分。') : null,
        )
      }

      function resultView() {
        const result = state.result
        if (!result) return null
        if (result.kind === 'create') {
          return h(
            'div',
            { style: section },
            h('div', { style: label }, '新快照'),
            h('div', { style: mono }, String(result.snapshot && result.snapshot.id)),
            h('div', { style: hint }, countText(result.snapshot && result.snapshot.counts)),
          )
        }
        if (result.kind === 'diff') {
          return h(
            'div',
            { style: section },
            h(
              'div',
              { style: label },
              '差异：' +
                String(result.diff && result.diff.from ? result.diff.from.id : '') +
                ' → ' +
                String(result.diff && result.diff.to ? result.diff.to.id : ''),
            ),
            diffView(result.diff),
          )
        }
        if (result.kind === 'restore') {
          const restore = result.restore || {}
          return h(
            'div',
            { style: section },
            h('div', { style: label }, '恢复结果'),
            h('div', { style: hint }, '恢复前备份：' + String(restore.backup || '')),
            h(
              'div',
              { style: hint },
              '已恢复：' + (Array.isArray(restore.restored) && restore.restored.length ? restore.restored.join('；') : '无'),
            ),
            Array.isArray(restore.skipped) && restore.skipped.length
              ? h('div', { style: hint }, '跳过：' + restore.skipped.join('；'))
              : null,
            Array.isArray(restore.errors) && restore.errors.length
              ? h('div', { style: { ...hint, color: '#d05a5a' } }, '错误：' + restore.errors.join('；'))
              : null,
          )
        }
        return null
      }

      return h(
        'div',
        { style: card },
        h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { flex: '1 1 320px' } },
            h('div', { style: { fontSize: 15, fontWeight: 700 } }, '系统快照：改之前先留一份'),
            h(
              'div',
              { style: hint },
              '只采集白名单：指定注册表键、hosts、环境变量、服务、防火墙、计划任务。' +
                '服务、防火墙、计划任务和系统环境变量只读；恢复只覆盖注册表、hosts、用户环境变量，并先自动备份。',
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(
              'input',
              {
                style: { ...control, width: 190 },
                value: state.label,
                placeholder: '快照标签，例如 改代理前',
                onChange: (event) => setState((prev) => ({ ...prev, label: event.target.value })),
              },
            ),
            h(
              'button',
              { style: state.creating ? disabled : primary, disabled: state.creating || state.loading, onClick: createSnapshot },
              state.creating ? '采集中…' : '立即快照',
            ),
          ),
        ),
        state.dataDir ? h('div', { style: mono }, '存储：' + state.dataDir) : null,
        h(
          'div',
          { style: section },
          h('div', { style: label }, '采集范围'),
          h(
            'div',
            { style: row },
            h('div', { style: hint }, '注册表白名单（每行一个，只接受 HKCU\ 或 HKLM\；不碰整个注册表）'),
            h('textarea', {
              style: area,
              value: state.settings.registryKeys.join('\n'),
              spellCheck: false,
              onChange: (event) =>
                updateSetting(
                  'registryKeys',
                  event.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
                ),
            }),
          ),
          h('div', { style: grid }, toggleItems),
          h(
            'div',
            { style: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' } },
            h(
              'label',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { style: hint }, '最多保留'),
              h('input', {
                type: 'number',
                min: 1,
                max: 100,
                style: { ...control, width: 76 },
                value: state.settings.maxSnapshots,
                onChange: (event) => updateSetting('maxSnapshots', Number(event.target.value) || 1),
              }),
              h('span', { style: hint }, '份'),
            ),
            h(
              'label',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { style: hint }, '保留'),
              h('input', {
                type: 'number',
                min: 1,
                max: 365,
                style: { ...control, width: 76 },
                value: state.settings.keepDays,
                onChange: (event) => updateSetting('keepDays', Number(event.target.value) || 1),
              }),
              h('span', { style: hint }, '天'),
            ),
            h(
              'label',
              { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { style: hint }, 'diff 最多'),
              h('input', {
                type: 'number',
                min: 20,
                max: 2000,
                style: { ...control, width: 86 },
                value: state.settings.diffMaxItems,
                onChange: (event) => updateSetting('diffMaxItems', Number(event.target.value) || 20),
              }),
              h('span', { style: hint }, '条'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { style: state.saving ? disabled : button, disabled: state.saving || state.loading, onClick: save }, state.saving ? '保存中…' : '保存设置'),
            h('span', { style: hint }, state.loading ? '读取中…' : ''),
          ),
        ),
        h(
          'div',
          { style: section },
          h('div', { style: label }, '恢复范围'),
          h('div', { style: hint }, '只允许这三类；每次恢复前会自动再建一份当前状态快照。'),
          h('div', { style: grid }, restoreItems),
        ),
        state.notice ? h('div', { style: { color: '#2f8f5b', fontSize: 12 } }, state.notice) : null,
        state.error ? h('div', { style: { color: '#d05a5a', fontSize: 12 } }, state.error) : null,
        resultView(),
        h(
          'div',
          { style: section },
          h('div', { style: label }, '已有快照'),
          snapshotItems.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, snapshotItems)
            : h('div', { style: hint }, state.loading ? '读取中…' : '还没有快照。点右上角“立即快照”建一份。'),
        ),
        h(
          'div',
          { style: hint },
          '提示：快照只存在本机 DSH_HOME，不上传。系统环境变量、服务、防火墙、计划任务只读，' +
            '不会出现在恢复范围里；hosts 恢复前会在原文件旁留 .bak-时间戳 备份。',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: NS,
              order: 46,
              label: () => '系统快照',
            },
            Panel,
          ),
        )
      },
    }
  },
})
