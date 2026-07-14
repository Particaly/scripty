'use strict'

const assert = require('node:assert/strict')
const { spawn: spawnChildProcess } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { LogFileRepository, ManagedScriptRepository } = require('../public/preload/file-repositories')
const { MetadataRepository, RepositoryError } = require('../public/preload/metadata-repository')
const { createRunService, createRunsApi } = require('../public/preload/run-service')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174020'
const TASK_ID = '123e4567-e89b-42d3-a456-426614174010'
const RESOLVED_NODE = '/fixture/home/.local/share/mise/shims/node'
const interpreterResolver = { resolve: () => RESOLVED_NODE }

/** Emits the native exit then stdio-close lifecycle used by real child processes. */
function completeChild(child, code = 0) {
  child.emit('exit', code)
  child.emit('close', code)
}

/** Creates runnable metadata, deterministic resolution, and captured spawn arguments. */
function createRunFixture(t, resolver = interpreterResolver) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-run-test-'))
  const metadata = new MetadataRepository(path.join(root, 'data'))
  const scripts = new ManagedScriptRepository(path.join(root, 'scripts'))
  const logs = new LogFileRepository(path.join(root, 'logs'))
  metadata.initialize()
  const stored = scripts.write(SCRIPT_ID, 'javascript', 'console.log("ok")')
  const now = '2026-07-11T00:00:00.000Z'
  metadata.write('scripts', [{ id: SCRIPT_ID, name: 'run.js', language: 'javascript', note: '', ...stored, createdAt: now, updatedAt: now }])
  metadata.write('tasks', [{ id: TASK_ID, name: '运行', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: 'node' }, args: ['包含 空格', '&& echo unsafe'], workingDirectory: null, cron: null, timeoutMs: null, enabled: false, concurrency: { policy: 'forbid', limit: 1 }, createdAt: now, updatedAt: now }])
  const calls = []
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  t.after(() => {
    if (child.listenerCount('exit') > 0) completeChild(child, 0)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const spawn = (...args) => { calls.push(args); queueMicrotask(() => child.emit('spawn')); return child }
  const timers = { setTimeout() { return 1 }, clearTimeout() {} }
  const service = createRunService(metadata, scripts, logs, spawn, process.platform, timers, resolver)
  return { api: service.api, startScheduled: service.startScheduled, calls, child, metadata, scripts, logs }
}

/** Proxies metadata access while allowing individual reads or writes to fail deterministically. */
function createFaultingMetadata(metadata, { onRead, onWrite } = {}) {
  return {
    read(repositoryName) {
      onRead?.(repositoryName)
      return metadata.read(repositoryName)
    },
    write(repositoryName, data) {
      onWrite?.(repositoryName, data)
      return metadata.write(repositoryName, data)
    }
  }
}

/** Flushes queued promise and event callbacks without introducing an arbitrary wall-clock delay. */
async function flushAsyncEvents() {
  await new Promise(resolve => setImmediate(resolve))
}

test('keeps Cron triggers private while scheduled starts persist their source', async (t) => {
  const fixture = createRunFixture(t)
  assert.equal((await fixture.api.start(TASK_ID, 'cron')).error.code, 'VALIDATION_ERROR')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-scheduled-run-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const metadata = new MetadataRepository(path.join(root, 'data'))
  const scripts = new ManagedScriptRepository(path.join(root, 'scripts'))
  const logs = new LogFileRepository(path.join(root, 'logs'))
  metadata.initialize()
  const stored = scripts.write(SCRIPT_ID, 'javascript', 'console.log("ok")')
  const now = '2026-07-12T00:00:00.000Z'
  metadata.write('scripts', [{ id: SCRIPT_ID, name: 'scheduled.js', language: 'javascript', note: '', ...stored, createdAt: now, updatedAt: now }])
  metadata.write('tasks', [{ id: TASK_ID, name: '定时运行', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: 'node' }, args: [], workingDirectory: null, cron: '* * * * *', timeoutMs: null, enabled: true, concurrency: { policy: 'forbid', limit: 1 }, createdAt: now, updatedAt: now }])
  const child = new EventEmitter(); child.pid = 5678; child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const service = createRunService(metadata, scripts, logs, () => { queueMicrotask(() => child.emit('spawn')); return child }, process.platform, { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)
  assert.equal(Object.hasOwn(service.api, 'startScheduled'), false)
  const result = await service.startScheduled(TASK_ID)
  assert.equal(result.ok, true)
  assert.equal(result.data.trigger, 'cron')
  completeChild(child, 0)
})

test('forbid policy rejects a scheduled overlap without creating false history', async (t) => {
  const fixture = createRunFixture(t)
  const first = await fixture.startScheduled(TASK_ID)
  const second = await fixture.startScheduled(TASK_ID)
  assert.equal(first.ok, true)
  assert.equal(first.data.trigger, 'cron')
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'RUN_ALREADY_ACTIVE')
  assert.equal(fixture.calls.length, 1)
  const records = fixture.metadata.read('runRecords')
  assert.equal(records.length, 1)
  assert.equal(records[0].trigger, 'cron')
})

test('limited policy admits scheduled runs up to its exact configured limit', async (t) => {
  const fixture = createRunFixture(t)
  const configured = fixture.metadata.read('tasks')[0]
  fixture.metadata.write('tasks', [{ ...configured, concurrency: { policy: 'limited', limit: 2 } }])
  const first = await fixture.startScheduled(TASK_ID)
  const second = await fixture.startScheduled(TASK_ID)
  const third = await fixture.startScheduled(TASK_ID)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(third.ok, false)
  assert.equal(third.error.code, 'RUN_LIMIT_REACHED')
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.metadata.read('runRecords').length, 2)
  assert.ok(fixture.metadata.read('runRecords').every(record => record.trigger === 'cron'))
})

test('recovers starting and running records as interrupted while preserving terminal history', (t) => {
  const fixture = createRunFixture(t)
  const { recoverInterruptedRuns } = require('../public/preload/run-service')
  const base = { taskId: TASK_ID, taskNameSnapshot: '运行', scriptNameSnapshot: 'run.js', trigger: 'manual', startedAt: '2026-07-11T00:00:00.000Z', finishedAt: null, exitCode: null, durationMs: null, logFileName: 'x.log', errorSummary: null }
  fixture.metadata.write('runRecords', [
    { ...base, id: 'starting', status: 'starting' },
    { ...base, id: 'running', status: 'running' },
    { ...base, id: 'success', status: 'success', finishedAt: '2026-07-11T00:00:01.000Z', durationMs: 1000, exitCode: 0 }
  ])
  recoverInterruptedRuns(fixture.metadata, '2026-07-11T00:00:05.000Z')
  const records = fixture.metadata.read('runRecords')
  assert.deepEqual(records.slice(0, 2).map(record => [record.status, record.durationMs, record.exitCode]), [['interrupted', 5000, null], ['interrupted', 5000, null]])
  assert.equal(records[2].status, 'success')
  assert.equal(records[2].durationMs, 1000)
})

test('injects merged global and task environment values into spawn options', async (t) => {
  const fixture = createRunFixture(t)
  fixture.metadata.write('environments', [
    { name: 'SCRIPTY_TEST', value: 'global', scope: 'global', taskId: null, enabled: true },
    { name: 'SCRIPTY_TEST', value: 'task', scope: 'task', taskId: TASK_ID, enabled: true },
    { name: 'SCRIPTY_DISABLED', value: 'no', scope: 'global', taskId: null, enabled: false }
  ])
  await fixture.api.start(TASK_ID)
  const env = fixture.calls[0][2].env
  assert.equal(env.SCRIPTY_TEST, 'task')
  assert.equal(Object.hasOwn(env, 'SCRIPTY_DISABLED'), false)
  assert.equal(env.PATH, process.env.PATH)
})

test('starts only persisted tasks through structured spawn arguments with shell disabled', async (t) => {
  const { api, calls, scripts } = createRunFixture(t)
  const result = await api.start(TASK_ID)
  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'running')
  assert.equal(result.data.trigger, 'manual')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], RESOLVED_NODE)
  assert.deepEqual(calls[0][1], [scripts.getFilePath(SCRIPT_ID, 'javascript'), '包含 空格', '&& echo unsafe'])
  assert.equal(calls[0][2].shell, false)
})

test('resolves an interpreter once per start and launches the selected mise shim path', async (t) => {
  let resolveCount = 0
  const resolver = {
    resolve() {
      resolveCount += 1
      return RESOLVED_NODE
    }
  }
  const { api, calls, metadata } = createRunFixture(t, resolver)
  const result = await api.start(TASK_ID)
  assert.equal(result.ok, true)
  assert.equal(resolveCount, 1)
  assert.equal(calls[0][0], RESOLVED_NODE)
  assert.equal(metadata.read('tasks')[0].interpreter.executable, 'node')
})

test('rejects unresolved interpreters before spawn, history, or log creation', async (t) => {
  const fixture = createRunFixture(t, { resolve: () => null })
  const result = await fixture.api.start(TASK_ID)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERPRETER_UNAVAILABLE')
  assert.equal(fixture.calls.length, 0)
  assert.equal(fixture.metadata.read('runRecords').length, 0)
  const logsDirectory = path.join(path.dirname(fixture.scripts.scriptsDirectory), 'logs')
  assert.deepEqual(fs.existsSync(logsDirectory) ? fs.readdirSync(logsDirectory) : [], [])
})

test('streams stdout and stderr as ordered events while appending both to the run log', async (t) => {
  const { api, child } = createRunFixture(t)
  const events = []
  const unsubscribe = api.subscribe(event => events.push(event))
  const started = await api.start(TASK_ID)
  child.stdout.emit('data', Buffer.from('out-1\n'))
  child.stderr.emit('data', Buffer.from('err-1\n'))
  child.stdout.emit('data', Buffer.from('out-2\n'))
  assert.deepEqual(events.map(event => [event.type, event.sequence]), [['status', 1], ['stdout', 2], ['stderr', 3], ['stdout', 4]])
  unsubscribe()
  child.stdout.emit('data', Buffer.from('ignored-event\n'))
  assert.equal(events.length, 4)
  assert.equal(started.data.status, 'running')
})

test('masks sensitive values before both live events and history log writes', async (t) => {
  const fixture = createRunFixture(t)
  fixture.metadata.write('environments', [{ name: 'SECRET', value: 'super-secret', scope: 'global', taskId: null, enabled: true, sensitive: true }])
  const events = []
  fixture.api.subscribe(event => events.push(event))
  const started = await fixture.api.start(TASK_ID)
  fixture.child.stdout.emit('data', Buffer.from('token=super-'))
  fixture.child.stdout.emit('data', Buffer.from('secret\n'))
  fixture.child.emit('exit', 0)
  const live = events.find(event => event.type === 'stdout').chunk
  const logPath = path.join(path.dirname(fixture.scripts.scriptsDirectory), 'logs', `${started.data.id}.log`)
  const log = fs.readFileSync(logPath, 'utf8')
  assert.equal(live.includes('super-secret'), false)
  assert.equal(log.includes('super-secret'), false)
  assert.match(live, /••••••••/)
  assert.match(log, /••••••••/)
})

test('creates one controlled log file per run and persists streamed output independently from metadata', async (t) => {
  const fixture = createRunFixture(t)
  const first = await fixture.api.start(TASK_ID)
  fixture.child.stdout.emit('data', Buffer.from('first-output\n'))
  fixture.child.emit('exit', 0)
  const records = fixture.metadata.read('runRecords')
  const record = records.find(item => item.id === first.data.id)
  assert.equal(record.logFileName, `${first.data.id}.log`)
  assert.equal(Object.hasOwn(record, 'output'), false)
  const logPath = path.join(path.dirname(fixture.scripts.scriptsDirectory), 'logs', record.logFileName)
  assert.equal(fs.readFileSync(logPath, 'utf8'), '[stdout] first-output\n')
})

test('persists a failed run record and its empty log when spawn emits an error', async (t) => {
  const fixture = createRunFixture(t)
  const errorChild = new EventEmitter()
  errorChild.pid = undefined
  errorChild.stdout = new EventEmitter()
  errorChild.stderr = new EventEmitter()
  const timers = { setTimeout() { return 1 }, clearTimeout() {} }
  const { createRunsApi } = require('../public/preload/run-service')
  const logs = new LogFileRepository(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'failed-logs'))
  const api = createRunsApi(fixture.metadata, fixture.scripts, logs, () => { queueMicrotask(() => errorChild.emit('error', new Error('missing'))); return errorChild }, process.platform, timers, interpreterResolver)
  const result = await api.start(TASK_ID)
  assert.equal(result.ok, false)
  const failed = fixture.metadata.read('runRecords').at(-1)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.errorSummary, '无法启动解释器')
  assert.equal(fs.existsSync(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'failed-logs', failed.logFileName)), true)
})

test('rejects missing interpreters and managed scripts before creating false run history', async (t) => {
  const missingInterpreter = createRunFixture(t, {
    resolve(kind, executable) {
      return executable === '/definitely/missing/interpreter' ? null : RESOLVED_NODE
    }
  })
  const tasks = missingInterpreter.metadata.read('tasks')
  tasks[0].interpreter.executable = '/definitely/missing/interpreter'
  missingInterpreter.metadata.write('tasks', tasks)
  const interpreterResult = await missingInterpreter.api.start(TASK_ID)
  assert.equal(interpreterResult.error.code, 'INTERPRETER_UNAVAILABLE')
  assert.equal(missingInterpreter.metadata.read('runRecords').length, 0)

  const missingScript = createRunFixture(t)
  missingScript.scripts.remove(SCRIPT_ID, 'javascript')
  const scriptResult = await missingScript.api.start(TASK_ID)
  assert.equal(scriptResult.error.code, 'SCRIPT_MISSING')
  assert.equal(missingScript.metadata.read('runRecords').length, 0)
})

test('keeps shell metacharacters and spaces as inert individual arguments', async (t) => {
  const { api, calls } = createRunFixture(t)
  await api.start(TASK_ID)
  const [, args, options] = calls[0]
  assert.equal(args[1], '包含 空格')
  assert.equal(args[2], '&& echo unsafe')
  assert.equal(args.length, 3)
  assert.equal(options.shell, false)
  assert.equal(Object.hasOwn(options, 'command'), false)
})

test('forbid policy atomically rejects a second start before the first spawn event arrives', async (t) => {
  const fixture = createRunFixture(t)
  const pendingStart = fixture.api.start(TASK_ID)
  const rejected = await fixture.api.start(TASK_ID)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'RUN_ALREADY_ACTIVE')
  assert.equal(fixture.calls.length, 1)
  await pendingStart
})

test('limited policy admits exactly its configured number of concurrent starts', async (t) => {
  const fixture = createRunFixture(t)
  const tasks = fixture.metadata.read('tasks')
  tasks[0].concurrency = { policy: 'limited', limit: 2 }
  fixture.metadata.write('tasks', tasks)
  const children = []
  const spawn = () => {
    const child = new EventEmitter()
    child.pid = 5000 + children.length
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  const { createRunsApi } = require('../public/preload/run-service')
  const timers = { setTimeout() { return 1 }, clearTimeout() {} }
  const api = createRunsApi(fixture.metadata, fixture.scripts, new LogFileRepository(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'limited-logs')), spawn, process.platform, timers, interpreterResolver)
  const first = api.start(TASK_ID)
  const second = api.start(TASK_ID)
  const third = await api.start(TASK_ID)
  assert.equal(third.ok, false)
  assert.equal(third.error.code, 'RUN_LIMIT_REACHED')
  assert.equal((await Promise.all([first, second])).every(result => result.ok), true)
})

test('uses task timeout override before the global default and classifies cleanup as timed_out', async (t) => {
  const fixture = createRunFixture(t)
  const tasks = fixture.metadata.read('tasks')
  tasks[0].timeoutMs = 2500
  fixture.metadata.write('tasks', tasks)
  fixture.metadata.write('settings', { ...fixture.metadata.read('settings'), defaultTimeoutMs: 9000 })
  let scheduledDelay
  let timeoutCallback
  const timers = { setTimeout(callback, delay) { timeoutCallback = callback; scheduledDelay = delay; return 1 }, clearTimeout() {} }
  fixture.child.kill = () => { queueMicrotask(() => completeChild(fixture.child, null)); return true }
  const { createRunsApi } = require('../public/preload/run-service')
  const api = createRunsApi(fixture.metadata, fixture.scripts, new LogFileRepository(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'timeout-logs')), fixture.calls.length ? undefined : (...args) => { fixture.calls.push(args); queueMicrotask(() => fixture.child.emit('spawn')); return fixture.child }, process.platform, timers, interpreterResolver)
  const started = await api.start(TASK_ID)
  assert.equal(scheduledDelay, 2500)
  await timeoutCallback()
  await new Promise(resolve => setImmediate(resolve))
  const record = fixture.metadata.read('runRecords').find(item => item.id === started.data.id)
  assert.equal(record.status, 'timed_out')
  assert.equal(record.exitCode, null)
})

test('falls back to the global timeout when a task has no override', async (t) => {
  const fixture = createRunFixture(t)
  fixture.metadata.write('settings', { ...fixture.metadata.read('settings'), defaultTimeoutMs: 4321 })
  let scheduledDelay
  const timers = { setTimeout(callback, delay) { scheduledDelay = delay; return 1 }, clearTimeout() {} }
  const { createRunsApi } = require('../public/preload/run-service')
  const api = createRunsApi(fixture.metadata, fixture.scripts, new LogFileRepository(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'default-timeout-logs')), (...args) => { fixture.calls.push(args); queueMicrotask(() => fixture.child.emit('spawn')); return fixture.child }, process.platform, timers, interpreterResolver)
  await api.start(TASK_ID)
  assert.equal(scheduledDelay, 4321)
})

test('uses taskkill with a literal PID argument array to terminate Windows process trees', async () => {
  const { terminateProcessTree } = require('../public/preload/run-service')
  const calls = []
  const killer = new EventEmitter()
  killer.stderr = new EventEmitter()
  const spawn = (...args) => { calls.push(args); queueMicrotask(() => killer.emit('exit', 0)); return killer }
  await terminateProcessTree({ pid: 4321 }, 'win32', spawn)
  assert.deepEqual(calls[0][0], 'taskkill')
  assert.deepEqual(calls[0][1], ['/PID', '4321', '/T', '/F'])
  assert.equal(calls[0][2].shell, false)
})

test('classifies user-requested process exit as stopped with no fabricated exit code', async (t) => {
  const { api, child, metadata } = createRunFixture(t)
  child.kill = () => { queueMicrotask(() => completeChild(child, null)); return true }
  const started = await api.start(TASK_ID)
  const stopping = api.stop(started.data.id)
  const stopped = await stopping
  assert.equal(stopped.ok, true)
  assert.equal(stopped.data.status, 'stopped')
  assert.equal(stopped.data.exitCode, null)
  assert.equal(metadata.read('runRecords').find(item => item.id === started.data.id).status, 'stopped')
})

test('renderer start input cannot override executable, arguments, or spawn options', async (t) => {
  const { api, calls } = createRunFixture(t)
  await api.start(TASK_ID, { executable: 'evil', shell: true, args: ['bad'] })
  assert.equal(calls.length, 0)
  const valid = await api.start(TASK_ID, 'manual')
  assert.equal(valid.ok, true)
  assert.equal(calls[0][0], RESOLVED_NODE)
  assert.equal(calls[0][2].shell, false)
})

test('finalizes exit and close exactly once while releasing the active slot', async (t) => {
  const fixture = createRunFixture(t)
  const events = []
  fixture.api.subscribe(event => events.push(event))
  const started = await fixture.api.start(TASK_ID)
  fixture.child.emit('exit', 0)
  fixture.child.emit('close', 0)
  assert.equal(events.filter(event => event.type === 'finished').length, 1)
  assert.equal(fixture.metadata.read('runRecords').find(record => record.id === started.data.id).status, 'success')
  assert.deepEqual((await fixture.api.getActive()).data, [])
  assert.equal((await fixture.api.start(TASK_ID)).ok, true)
})

test('retains output delivered after exit until close commits the run', async (t) => {
  const fixture = createRunFixture(t)
  const events = []
  fixture.api.subscribe(event => events.push(event))
  const started = await fixture.api.start(TASK_ID)

  fixture.child.emit('exit', 0)
  fixture.child.stdout.emit('data', Buffer.from('trailing-output\n'))
  assert.equal(events.filter(event => event.type === 'finished').length, 0)
  assert.equal((await fixture.api.getActive()).data.length, 1)

  fixture.child.emit('close', 0)
  const logPath = path.join(fixture.logs.logsDirectory, `${started.data.id}.log`)
  assert.match(fs.readFileSync(logPath, 'utf8'), /\[stdout\] trailing-output\n/)
  assert.equal(events.filter(event => event.type === 'stdout').length, 1)
  assert.equal(events.filter(event => event.type === 'finished').length, 1)
  assert.deepEqual((await fixture.api.getActive()).data, [])
})

test('uses close as a terminal fallback when no exit event is delivered', async (t) => {
  const fixture = createRunFixture(t)
  const started = await fixture.api.start(TASK_ID)
  fixture.child.emit('close', 0)
  const record = fixture.metadata.read('runRecords').find(item => item.id === started.data.id)
  assert.equal(record.status, 'success')
  assert.equal(record.exitCode, 0)
  assert.deepEqual((await fixture.api.getActive()).data, [])
})

test('classifies an error emitted after spawn as failed and removes the active run', async (t) => {
  const fixture = createRunFixture(t)
  const started = await fixture.api.start(TASK_ID)
  fixture.child.emit('error', new Error('child channel failed'))
  const record = fixture.metadata.read('runRecords').find(item => item.id === started.data.id)
  assert.equal(record.status, 'failed')
  assert.match(record.errorSummary, /child channel failed/)
  assert.deepEqual((await fixture.api.getActive()).data, [])
})

test('force-finalizes an unresponsive stopped process after bounded escalation', async (t) => {
  const fixture = createRunFixture(t)
  const callbacks = []
  const timers = {
    setTimeout(callback) { callbacks.push(callback); return callbacks.length },
    clearTimeout() {}
  }
  const child = fixture.child
  child.kill = () => true
  const api = createRunsApi(fixture.metadata, fixture.scripts, new LogFileRepository(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'forced-stop-logs')), () => { queueMicrotask(() => child.emit('spawn')); return child }, 'linux', timers, interpreterResolver)
  const started = await api.start(TASK_ID)
  const stopping = api.stop(started.data.id)
  await callbacks[1]()
  callbacks[2]()
  const result = await stopping
  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'stopped')
  assert.deepEqual((await api.getActive()).data, [])
})

test('removes a newly created log when the starting record cannot be persisted', async (t) => {
  const fixture = createRunFixture(t)
  let failNextRunWrite = true
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onWrite(repositoryName) {
      if (repositoryName === 'runRecords' && failNextRunWrite) {
        failNextRunWrite = false
        throw new RepositoryError('WRITE_FAILED', '无法写入 starting 状态')
      }
    }
  })
  const calls = []
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, (...args) => {
    calls.push(args)
    queueMicrotask(() => fixture.child.emit('spawn'))
    return fixture.child
  }, process.platform, { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)

  const failed = await api.start(TASK_ID)
  const retried = await api.start(TASK_ID)

  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'WRITE_FAILED')
  assert.equal(retried.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(fs.readdirSync(fixture.logs.logsDirectory), [`${retried.data.id}.log`])
})

test('returns a storage error when a synchronous spawn failure cannot be recorded', async (t) => {
  const fixture = createRunFixture(t)
  let runRecordWriteCount = 0
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onWrite(repositoryName) {
      if (repositoryName !== 'runRecords') return
      runRecordWriteCount += 1
      if (runRecordWriteCount === 2) throw new RepositoryError('PERMISSION_DENIED', '无法写入失败终态')
    }
  })
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, () => {
    throw new Error('synchronous spawn failure')
  }, process.platform, { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)

  const result = await api.start(TASK_ID)

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PERMISSION_DENIED')
  assert.equal(fixture.metadata.read('runRecords')[0].status, 'starting')
})

test('terminates a spawned child when timeout monitoring cannot be installed', async (t) => {
  const fixture = createRunFixture(t)
  let terminationRequested = false
  fixture.child.kill = () => {
    terminationRequested = true
    queueMicrotask(() => completeChild(fixture.child, null))
    return true
  }
  const timers = { setTimeout() { throw new Error('timer unavailable') }, clearTimeout() {} }
  const events = []
  const api = createRunsApi(fixture.metadata, fixture.scripts, fixture.logs, () => {
    queueMicrotask(() => fixture.child.emit('spawn'))
    return fixture.child
  }, 'linux', timers, interpreterResolver)
  api.subscribe(event => events.push(event))

  const result = await api.start(TASK_ID)
  await flushAsyncEvents()

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.equal(result.error.message, '无法启动运行超时监控')
  assert.equal(terminationRequested, true)
  assert.equal(events.some(event => event.type === 'status'), false)
  const finishedEvents = events.filter(event => event.type === 'finished')
  assert.equal(finishedEvents.length, 1)
  const record = fixture.metadata.read('runRecords')[0]
  assert.equal(record.status, 'failed')
  assert.equal(record.errorSummary, '无法启动运行超时监控')
  assert.equal(record.exitCode, null)
  assert.deepEqual(finishedEvents[0].record, record)
  assert.deepEqual((await api.getActive()).data, [])
})

test('fails before run artifacts when global timeout settings cannot be read', async (t) => {
  const fixture = createRunFixture(t)
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onRead(repositoryName) {
      if (repositoryName === 'settings') throw new RepositoryError('DATA_CORRUPTED', 'settings.json 无法读取')
    }
  })
  const calls = []
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, (...args) => {
    calls.push(args)
    return fixture.child
  }, process.platform, { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)

  const result = await api.start(TASK_ID)

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'DATA_CORRUPTED')
  assert.equal(calls.length, 0)
  assert.deepEqual(fixture.metadata.read('runRecords'), [])
  assert.deepEqual(fs.existsSync(fixture.logs.logsDirectory) ? fs.readdirSync(fixture.logs.logsDirectory) : [], [])
  assert.equal((await api.start(TASK_ID)).error.code, 'DATA_CORRUPTED')
})

test('uses a task timeout override without reading global settings', async (t) => {
  const fixture = createRunFixture(t)
  const tasks = fixture.metadata.read('tasks')
  tasks[0].timeoutMs = 2468
  fixture.metadata.write('tasks', tasks)
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onRead(repositoryName) {
      if (repositoryName === 'settings') throw new RepositoryError('READ_FAILED', 'settings.json 不应读取')
    }
  })
  let scheduledDelay
  const timers = { setTimeout(callback, delay) { scheduledDelay = delay; return 1 }, clearTimeout() {} }
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, () => {
    queueMicrotask(() => fixture.child.emit('spawn'))
    return fixture.child
  }, process.platform, timers, interpreterResolver)

  const result = await api.start(TASK_ID)

  assert.equal(result.ok, true)
  assert.equal(scheduledDelay, 2468)
})

test('terminates a spawned child and preserves the storage code when running state persistence fails', async (t) => {
  const fixture = createRunFixture(t)
  let runRecordWriteCount = 0
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onWrite(repositoryName) {
      if (repositoryName !== 'runRecords') return
      runRecordWriteCount += 1
      if (runRecordWriteCount === 2) throw new RepositoryError('DISK_FULL', '无法写入 run-records.json')
    }
  })
  let terminationRequested = false
  fixture.child.kill = () => {
    terminationRequested = true
    queueMicrotask(() => completeChild(fixture.child, null))
    return true
  }
  const events = []
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, () => {
    queueMicrotask(() => fixture.child.emit('spawn'))
    return fixture.child
  }, 'linux', { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)
  api.subscribe(event => events.push(event))

  const result = await api.start(TASK_ID)
  await flushAsyncEvents()

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'DISK_FULL')
  assert.equal(terminationRequested, true)
  assert.equal(events.some(event => event.type === 'status'), false)
  assert.equal(events.filter(event => event.type === 'finished').length, 1)
  assert.equal(events.at(-1).record.status, 'failed')
  assert.equal(fixture.metadata.read('runRecords')[0].status, 'failed')
  assert.deepEqual((await api.getActive()).data, [])
})

test('publishes a terminal event after a bounded retry commits the close-time final record', async (t) => {
  const fixture = createRunFixture(t)
  let runRecordWriteCount = 0
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onWrite(repositoryName) {
      if (repositoryName !== 'runRecords') return
      runRecordWriteCount += 1
      if (runRecordWriteCount === 3) throw new RepositoryError('WRITE_FAILED', '最终状态暂时无法写入')
    }
  })
  const events = []
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, () => {
    queueMicrotask(() => fixture.child.emit('spawn'))
    return fixture.child
  }, process.platform, { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)
  api.subscribe(event => events.push(event))
  const started = await api.start(TASK_ID)

  fixture.child.emit('exit', 0)
  fixture.child.emit('close', 0)
  const finishedEvents = events.filter(event => event.type === 'finished')
  const persisted = fixture.metadata.read('runRecords').find(record => record.id === started.data.id)
  assert.equal(finishedEvents.length, 1)
  assert.deepEqual(finishedEvents[0].record, persisted)
  assert.equal(persisted.status, 'success')
  assert.deepEqual(events.map(event => event.sequence), [1, 2])
  assert.deepEqual((await api.getActive()).data, [])
})

test('reports persistent terminal write failure without publishing an uncommitted result', async (t) => {
  const fixture = createRunFixture(t)
  let runRecordWriteCount = 0
  const faultingMetadata = createFaultingMetadata(fixture.metadata, {
    onWrite(repositoryName) {
      if (repositoryName !== 'runRecords') return
      runRecordWriteCount += 1
      if (runRecordWriteCount >= 3) throw new RepositoryError('PERMISSION_DENIED', '最终状态无法写入')
    }
  })
  fixture.child.kill = () => {
    queueMicrotask(() => completeChild(fixture.child, null))
    return true
  }
  const events = []
  const api = createRunsApi(faultingMetadata, fixture.scripts, fixture.logs, () => {
    queueMicrotask(() => fixture.child.emit('spawn'))
    return fixture.child
  }, 'linux', { setTimeout() { return 1 }, clearTimeout() {} }, interpreterResolver)
  api.subscribe(event => events.push(event))
  const started = await api.start(TASK_ID)
  const stopped = await api.stop(started.data.id)

  assert.equal(stopped.ok, false)
  assert.equal(stopped.error.code, 'PERMISSION_DENIED')
  assert.equal(events.filter(event => event.type === 'finished').length, 0)
  assert.equal(fixture.metadata.read('runRecords').find(record => record.id === started.data.id).status, 'running')
  assert.equal((await api.getActive()).data.length, 1)

  fixture.child.emit('close', null)
  assert.equal(events.filter(event => event.type === 'finished').length, 0)
  assert.equal((await api.getActive()).data.length, 1)
})

test('runs a real two-line JavaScript task to success without leaving an active record', async (t) => {
  const fixture = createRunFixture(t, { resolve: () => process.execPath })
  fixture.scripts.write(SCRIPT_ID, 'javascript', 'const a = 1\nconsole.log(a)\n')
  const logs = new LogFileRepository(path.join(path.dirname(fixture.scripts.scriptsDirectory), 'real-process-logs'))
  const service = createRunService(fixture.metadata, fixture.scripts, logs, spawnChildProcess, process.platform, { setTimeout, clearTimeout }, { resolve: () => process.execPath })
  const events = []
  const finished = new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error('real JavaScript run did not finish')), 5000)
    service.api.subscribe(event => {
      events.push(event)
      if (event.type !== 'finished') return
      clearTimeout(watchdog)
      resolve(event.record)
    })
  })
  const started = await service.api.start(TASK_ID)
  assert.equal(started.ok, true)
  const record = await finished
  assert.equal(record.status, 'success')
  assert.equal(record.exitCode, 0)
  assert.equal(events.filter(event => event.type === 'finished').length, 1)
  const logPath = path.join(path.dirname(fixture.scripts.scriptsDirectory), 'real-process-logs', record.logFileName)
  assert.match(fs.readFileSync(logPath, 'utf8'), /\[stdout\] 1\n/)
  assert.deepEqual((await service.api.getActive()).data, [])
})

test('rejects missing task IDs before spawn and persists successful exit state', async (t) => {
  const { api, calls, child, metadata } = createRunFixture(t)
  const rejected = await api.start('123e4567-e89b-42d3-a456-426614174099')
  assert.equal(rejected.ok, false)
  assert.equal(calls.length, 0)
  const started = await api.start(TASK_ID)
  completeChild(child, 0)
  const record = metadata.read('runRecords').find(item => item.id === started.data.id)
  assert.equal(record.status, 'success')
  assert.equal(record.exitCode, 0)
})
