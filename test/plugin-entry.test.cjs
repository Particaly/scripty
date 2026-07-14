'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const pluginEntryPath = path.join(__dirname, '../src/plugin-entry.ts')

/** Transpiles the framework-free TypeScript helper with the project's compiler so tests do not depend on Node's native type stripping. */
function loadPluginEntry() {
  const source = fs.readFileSync(pluginEntryPath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    },
    fileName: pluginEntryPath
  }).outputText
  const compiledModule = new Module(pluginEntryPath, module)
  compiledModule.filename = pluginEntryPath
  compiledModule.paths = module.paths
  compiledModule._compile(output, pluginEntryPath)
  return compiledModule.exports
}

const entry = loadPluginEntry()

/** Builds a complete task summary fixture while allowing each entry to override the fields relevant to a test. */
function createTask(overrides = {}) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174010',
    name: '每日备份',
    note: '同步项目文件',
    scriptId: '123e4567-e89b-42d3-a456-426614174020',
    scriptName: 'backup.js',
    interpreter: { kind: 'javascript', executable: 'node' },
    args: [],
    workingDirectory: null,
    cron: null,
    timeoutMs: null,
    enabled: true,
    concurrency: { policy: 'forbid', limit: 1 },
    readiness: 'ready',
    nextRunAt: null,
    activeRunCount: 0,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides
  }
}

test('maps all plugin entries to safe existing application sections', () => {
  assert.equal(entry.resolvePluginSection(entry.TASK_LIBRARY_FEATURE), 'tasks')
  assert.equal(entry.resolvePluginSection(entry.RUN_TASK_FEATURE), 'tasks')
  assert.equal(entry.resolvePluginSection(entry.RUNNING_TASKS_FEATURE), 'running')
  assert.equal(entry.resolvePluginSection('unknown-feature'), 'tasks')
  assert.equal(entry.resolvePluginSection(null), 'tasks')
})

test('normalizes only text payloads and never treats structured host input as a query', () => {
  const { normalizeMainPushQuery } = entry
  assert.equal(normalizeMainPushQuery('  每日 BACKUP  '), '每日 backup')
  assert.equal(normalizeMainPushQuery({ path: '/tmp/task.js' }), '')
  assert.equal(normalizeMainPushQuery(['rm', '-rf']), '')
  assert.equal(normalizeMainPushQuery(42), '')
})

test('builds display-only candidates for ready tasks and filters searchable metadata', () => {
  const { buildRunnableTaskCandidates } = entry
  const ready = createTask()
  const duplicateName = createTask({
    id: '123e4567-e89b-42d3-a456-426614174011',
    scriptName: 'mirror.py',
    note: '远端镜像'
  })
  const unavailable = createTask({
    id: '123e4567-e89b-42d3-a456-426614174012',
    name: '不可运行',
    readiness: 'interpreter_unavailable'
  })

  const candidates = buildRunnableTaskCandidates([ready, duplicateName, unavailable])
  assert.deepEqual(candidates, [
    { title: '每日备份', text: `backup.js · ${ready.id}` },
    { title: '每日备份', text: `mirror.py · ${duplicateName.id}` }
  ])
  assert.deepEqual(buildRunnableTaskCandidates([ready, duplicateName], 'MIRROR'), [candidates[1]])
  assert.deepEqual(buildRunnableTaskCandidates([ready, duplicateName], '同步项目'), [candidates[0]])
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['text', 'title'])
})

test('resolves only an exact current runnable candidate and rejects stale or altered selections', () => {
  const { buildRunnableTaskCandidates, resolveSelectedTask } = entry
  const task = createTask()
  const candidate = buildRunnableTaskCandidates([task])[0]

  assert.equal(resolveSelectedTask([task], candidate)?.id, task.id)
  assert.equal(resolveSelectedTask([], candidate), null)
  assert.equal(resolveSelectedTask([{ ...task, readiness: 'script_missing' }], candidate), null)
  assert.equal(resolveSelectedTask([task], { ...candidate, title: '其他任务' }), null)
  assert.equal(resolveSelectedTask([task], { ...candidate, text: `${candidate.text}; rm -rf /` }), null)
  assert.equal(resolveSelectedTask([task], { title: task.name, text: task.id }), null)
})

test('declares separate safe features for library, dynamic task selection, and active runs', () => {
  const manifestPath = path.join(__dirname, '../public/plugin.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const codes = manifest.features.map(feature => feature.code)
  assert.deepEqual(codes, ['scripty', 'scripty-run-task', 'scripty-running'])
  assert.equal(new Set(codes).size, codes.length)
  assert.equal(manifest.features.find(feature => feature.code === 'scripty-run-task').mainPush, true)
  for (const feature of manifest.features) {
    assert.equal(feature.cmds.every(command => typeof command === 'string'), true)
  }
})
