import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { getReleasePaths, verifyReleaseDirectory } from './verify-release.mjs'

const MIME_TYPES = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }

/** Starts a loopback-only static server rooted at the verified release directory and returns its URL and cleanup. */
async function startStaticServer(directory) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) { response.writeHead(400); response.end(); return }
    const filePath = path.join(directory, relative)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) throw new Error('not a file')
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream' })
      fs.createReadStream(filePath).pipe(response)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise(resolve => server.close(resolve)) }
}

/** Injects the minimum explicit ZTools and Scripty APIs required to exercise the production renderer safely. */
async function installHostMocks(page) {
  await page.addInitScript(() => {
    const callbacks = { enter: null, pushLoad: null, pushSelect: null }
    window.__ztoolsCallbacks = callbacks
    window.ztools = {
      onPluginEnter(callback) { callbacks.enter = callback }, onPluginOut() {},
      onMainPush(load, select) { callbacks.pushLoad = load; callbacks.pushSelect = select },
      showMainWindow() {}, hideMainWindow() {}, outPlugin() {}, getPath() { return '/tmp' }, getFileIcon() { return '' }
    }
    const ok = data => Promise.resolve({ ok: true, data, requestId: 'release-smoke' })
    const runListeners = new Set()
    const runningRecord = { id: 'smoke-run', taskId: 'smoke-task', taskNameSnapshot: '快任务', scriptNameSnapshot: 'smoke.js', trigger: 'manual', startedAt: '2026-07-13T00:00:00.000Z', finishedAt: null, status: 'running', exitCode: null, durationMs: null, logFileName: 'smoke-run.log', errorSummary: null, pid: 1234, sequence: 1 }
    const finishedRecord = { ...runningRecord, finishedAt: '2026-07-13T00:00:00.010Z', status: 'success', exitCode: 0, durationMs: 10 }
    let historyCallCount = 0
    const emptyPage = { items: [], total: 0, page: 1, pageSize: 20 }
    window.scripty = {
      app: { getSchedulerStatus: () => ok('inactive'), subscribeSchedulerStatus: listener => { listener('inactive'); return () => {} }, initialize: () => ok({}) },
      scripts: { list: () => ok([]) }, tasks: { list: () => ok([]) },
      runs: {
        getActive: async () => {
          for (const listener of runListeners) listener({ type: 'finished', runId: finishedRecord.id, sequence: 2, record: finishedRecord })
          return { ok: true, data: [runningRecord], requestId: 'release-smoke' }
        },
        subscribe: listener => { runListeners.add(listener); return () => runListeners.delete(listener) }
      },
      environments: { list: () => ok([]) },
      history: {
        list: async () => {
          historyCallCount += 1
          if (historyCallCount > 1) return { ok: true, data: { ...emptyPage, items: [finishedRecord], total: 1 }, requestId: 'release-smoke' }
          queueMicrotask(() => { for (const listener of runListeners) listener({ type: 'finished', runId: finishedRecord.id, sequence: 3, record: finishedRecord }) })
          await new Promise(resolve => setTimeout(resolve, 25))
          return { ok: true, data: { ...emptyPage, items: [runningRecord], total: 1 }, requestId: 'release-smoke' }
        }
      },
      settings: { get: () => ok({ defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, defaultInterpreters: { javascript: null, python: null, powershell: null, shell: null }, defaultWorkingDirectory: null, schedulerNoticeAcknowledged: false, updatedAt: '1970-01-01T00:00:00.000Z' }) },
      backups: {}
    }
  })
}

/** Resolves a usable Chrome executable override while letting Playwright use its managed browser elsewhere. */
function resolveBrowserOptions(executablePath) {
  if (executablePath) return { executablePath }
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return process.platform === 'darwin' && fs.existsSync(macChrome) ? { executablePath: macChrome } : {}
}

/** Drives all release navigation paths, one dialog cancellation, the host route, and the 700px supported viewport. */
export async function smokeRenderer(directory, options = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'))
  verifyReleaseDirectory(directory, packageJson)
  const server = await startStaticServer(directory)
  const browser = await chromium.launch({ headless: true, ...resolveBrowserOptions(options.executablePath) })
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } })
  const errors = []
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  page.on('pageerror', error => errors.push(`page: ${error.message}`))
  page.on('requestfailed', request => errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? ''}`))
  page.on('request', request => { if (request.url().includes('localhost:5173')) errors.push(`development request: ${request.url()}`) })
  try {
    await installHostMocks(page)
    await page.goto(server.url, { waitUntil: 'networkidle' })
    for (const tab of ['任务', '脚本', '环境变量', '运行中', '运行历史', '备份', '设置']) {
      const control = page.getByRole('tab', { name: tab, exact: true })
      await control.click()
      if (await control.getAttribute('aria-selected') !== 'true') throw new Error(`Navigation did not select ${tab}`)
    }
    await page.getByRole('button', { name: '调度说明' }).click()
    if (!await page.getByRole('dialog').isVisible()) throw new Error('Scheduler confirmation dialog did not open')
    await page.getByRole('button', { name: '稍后确认' }).click()
    await page.setViewportSize({ width: 700, height: 820 })
    await page.evaluate(() => window.__ztoolsCallbacks.enter?.({ code: 'scripty-running' }))
    if (await page.getByRole('tab', { name: '运行中', exact: true }).getAttribute('aria-selected') !== 'true') throw new Error('Host running-task route failed')
    await page.waitForTimeout(50)
    if (!await page.getByText('当前没有运行中的任务').isVisible()) throw new Error('Finished run was restored from a stale active snapshot')
    await page.getByRole('tab', { name: '运行历史', exact: true }).click()
    await page.waitForTimeout(75)
    if (!await page.getByText('成功', { exact: true }).first().isVisible()) throw new Error('History completion refresh was overwritten by a stale response')
    if (errors.length) throw new Error(errors.join('\n'))
    return { tabs: 7, viewport: '700x820', hostRoute: 'scripty-running' }
  } finally {
    await browser.close()
    await server.close()
  }
}

/** Runs the renderer smoke against the current versioned release directory. */
async function main() {
  const { directory } = getReleasePaths()
  console.log(JSON.stringify(await smokeRenderer(directory), null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main()
