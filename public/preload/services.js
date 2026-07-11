const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const lifecycleLogPath = path.join(os.tmpdir(), 'scripty-preload-lifecycle.jsonl')
const childProcessLogPath = path.join(os.tmpdir(), 'scripty-child-process.jsonl')
const preloadStartedAt = new Date().toISOString()
let probeChild = null

function appendJsonLine(filePath, entry) {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' })
  return entry
}

function appendLifecycleEvent(event, details = {}) {
  return appendJsonLine(lifecycleLogPath, {
    timestamp: new Date().toISOString(),
    event,
    pid: process.pid,
    preloadStartedAt,
    ...details
  })
}

function appendChildProcessEvent(event, details = {}) {
  return appendJsonLine(childProcessLogPath, {
    timestamp: new Date().toISOString(),
    event,
    parentPid: process.pid,
    childPid: probeChild?.pid ?? details.childPid,
    ...details
  })
}

appendLifecycleEvent('preload-started')

setInterval(() => {
  appendLifecycleEvent('preload-heartbeat')
}, 1000)

process.once('exit', (code) => {
  appendLifecycleEvent('preload-process-exit', { code })
})

function getDataPaths() {
  const root = path.join(window.ztools.getPath('userData'), 'scripty')
  return {
    root,
    metadata: path.join(root, 'data'),
    scripts: path.join(root, 'scripts'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups')
  }
}

function ensureDataPaths() {
  const dataPaths = getDataPaths()
  Object.values(dataPaths).forEach((directory) => fs.mkdirSync(directory, { recursive: true }))
  return dataPaths
}

// 通过 window 对象向渲染进程注入 nodejs 能力
window.services = {
  dataPaths: {
    ensure: ensureDataPaths
  },
  lifecycleProbe: {
    record(event, details) {
      return appendLifecycleEvent(event, details)
    },
    status() {
      return {
        lifecycleLogPath,
        pid: process.pid,
        preloadStartedAt
      }
    },
    readLog() {
      if (!fs.existsSync(lifecycleLogPath)) return ''
      return fs.readFileSync(lifecycleLogPath, { encoding: 'utf-8' })
    },
    clearLog() {
      fs.writeFileSync(lifecycleLogPath, '', { encoding: 'utf-8' })
      return appendLifecycleEvent('probe-log-cleared')
    }
  },
  childProcessProbe: {
    start() {
      if (probeChild) return { started: false, childPid: probeChild.pid, childProcessLogPath }
      const script = [
        "let count = 0",
        "console.log('child-started')",
        "console.error('child-stderr-started')",
        "setInterval(() => { count += 1; console.log('tick:' + count); if (count % 2 === 0) console.error('stderr-tick:' + count) }, 500)"
      ].join(';')
      probeChild = spawn('node', ['-e', script], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      appendChildProcessEvent('child-spawned')
      probeChild.stdout.on('data', (chunk) => appendChildProcessEvent('child-stdout', { output: chunk.toString() }))
      probeChild.stderr.on('data', (chunk) => appendChildProcessEvent('child-stderr', { output: chunk.toString() }))
      probeChild.once('error', (error) => appendChildProcessEvent('child-error', { error: error.message }))
      probeChild.once('exit', (code, signal) => {
        const childPid = probeChild?.pid
        appendChildProcessEvent('child-exit', { childPid, code, signal })
        probeChild = null
      })
      return { started: true, childPid: probeChild.pid, childProcessLogPath }
    },
    stop() {
      if (!probeChild) return false
      appendChildProcessEvent('child-stop-requested')
      return probeChild.kill()
    },
    status() {
      return { running: probeChild !== null, childPid: probeChild?.pid, childProcessLogPath }
    },
    readLog() {
      if (!fs.existsSync(childProcessLogPath)) return ''
      return fs.readFileSync(childProcessLogPath, { encoding: 'utf-8' })
    },
    clearLog() {
      fs.writeFileSync(childProcessLogPath, '', { encoding: 'utf-8' })
    }
  },
  // 读文件
  readFile(file) {
    return fs.readFileSync(file, { encoding: 'utf-8' })
  },
  // 文本写入到下载目录
  writeTextFile(text) {
    const filePath = path.join(window.ztools.getPath('downloads'), Date.now().toString() + '.txt')
    fs.writeFileSync(filePath, text, { encoding: 'utf-8' })
    return filePath
  },
  // 图片写入到下载目录
  writeImageFile(base64Url) {
    const matchs = /^data:image\/([a-z]{1,20});base64,/i.exec(base64Url)
    if (!matchs) return
    const filePath = path.join(
      window.ztools.getPath('downloads'),
      Date.now().toString() + '.' + matchs[1]
    )
    fs.writeFileSync(filePath, base64Url.substring(matchs[0].length), { encoding: 'base64' })
    return filePath
  }
}
