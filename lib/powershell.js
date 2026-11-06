/**
 * 调用 lib/snapshot.ps1，并把请求/结果走临时 JSON 文件。
 *
 * PowerShell 5.1 的控制台编码不可靠，所以脚本统一输出 ASCII JSON（非 ASCII 转 \uXXXX）；
 * 这里再按 UTF-8 解码，避免中文变成乱码。
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : ''
      const err = typeof stderr === 'string' ? stderr : ''
      if (out.trim() !== '') {
        resolve({ out, err, error })
        return
      }
      if (error) {
        const reason =
          error.killed && error.signal
            ? 'PowerShell 超时或被终止（' + error.signal + '）。'
            : err.trim() || error.message || 'PowerShell 执行失败。'
        reject(new Error(reason))
        return
      }
      resolve({ out: '', err, error: null })
    })
  })
}

export function createPowerShellRunner({ scriptPath, tempDir, timeoutMs = 180000 }) {
  if (typeof scriptPath !== 'string' || scriptPath === '') {
    throw new Error('缺少 snapshot.ps1 路径。')
  }
  return async function runPowerShell(request) {
    mkdirSync(tempDir, { recursive: true })
    const requestFile = join(tempDir, 'request-' + randomBytes(8).toString('hex') + '.json')
    writeFileSync(requestFile, JSON.stringify(request), 'utf8')
    try {
      const { out, err } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestFile', requestFile],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
        },
      )
      let parsed
      try {
        parsed = JSON.parse(out.trim())
      } catch {
        throw new Error(
          'PowerShell 返回无法解析：' +
            out.slice(0, 800) +
            (err.trim() !== '' ? ' / ' + err.trim().slice(0, 800) : ''),
        )
      }
      if (!parsed || parsed.ok !== true) {
        throw new Error(parsed && parsed.error ? parsed.error : 'PowerShell 执行失败。')
      }
      return parsed
    } finally {
      rmSync(requestFile, { force: true })
    }
  }
}
