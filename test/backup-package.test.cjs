'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const test = require('node:test')
const {
  buildDefaultExportPackageFiles,
  buildExportPackageFiles,
  createDefaultExportOptions
} = require('../public/preload/backup-package')

const IDS = {
  script: '123e4567-e89b-42d3-a456-426614174020',
  task: '123e4567-e89b-42d3-a456-426614174010',
  normalEnvironment: '123e4567-e89b-42d3-a456-426614174030',
  sensitiveEnvironment: '123e4567-e89b-42d3-a456-426614174031'
}
const SCRIPT_CONTENT = 'console.log("中文 backup")\n'
const EXPORTED_AT = '2026-07-12T08:00:00.000Z'

/** Calculates the protocol's lowercase SHA-256 for fixture content or emitted bytes. */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Creates a complete repository snapshot and controlled script reader for package-builder tests. */
function createFixture(options = {}) {
  const script = {
    id: IDS.script,
    name: 'backup.js',
    managedFileName: `${IDS.script}.js`,
    language: 'javascript',
    contentHash: sha256(SCRIPT_CONTENT),
    note: '备份脚本',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  }
  const task = {
    id: IDS.task,
    name: '每日备份',
    note: '同步项目',
    scriptId: IDS.script,
    interpreter: { kind: 'javascript', executable: '/device/bin/node-private' },
    args: ['--target', '中文 目录'],
    workingDirectory: '/device/private/workspace',
    cron: '0 2 * * *',
    timeoutMs: 60000,
    enabled: true,
    concurrency: { policy: 'forbid', limit: 1 },
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  }
  const environments = [
    {
      id: IDS.normalEnvironment,
      name: 'OUTPUT_MODE',
      value: '普通值',
      note: '普通变量',
      scope: 'global',
      taskId: null,
      enabled: true,
      sensitive: false,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z'
    },
    {
      id: IDS.sensitiveEnvironment,
      name: 'SECRET_TOKEN',
      value: 'sensitive-plaintext-fixture',
      note: '敏感变量',
      scope: 'task',
      taskId: IDS.task,
      enabled: true,
      sensitive: true,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z'
    }
  ]
  const settings = {
    defaultTimeoutMs: 300000,
    defaultConcurrency: { policy: 'limited', limit: 2 },
    logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 },
    defaultInterpreters: { javascript: '/device/default/node', python: null, powershell: null, shell: null },
    defaultWorkingDirectory: '/device/default/workspace',
    schedulerNoticeAcknowledged: true,
    updatedAt: '2026-07-11T00:00:00.000Z'
  }
  return {
    appVersion: '1.0.0',
    exportedAt: EXPORTED_AT,
    options: {
      includeEnvironments: true,
      includeEnvironmentValues: false,
      includeSensitiveValues: false
    },
    envelopes: {
      scripts: { schemaVersion: 1, data: [script] },
      tasks: { schemaVersion: 1, data: [task] },
      environments: { schemaVersion: 1, data: environments },
      settings: { schemaVersion: 1, data: settings }
    },
    readScriptContent: () => SCRIPT_CONTENT,
    ...options
  }
}

/** Parses one named JSON file from a completed logical package. */
function readJson(result, filePath) {
  const file = result.files.find((item) => item.path === filePath)
  assert.ok(file, `missing ${filePath}`)
  return JSON.parse(file.content.toString('utf8'))
}

/** Concatenates emitted bytes for assertions that local-only values never enter any package file. */
function readAllText(result) {
  return result.files.map((file) => file.content.toString('utf8')).join('\n')
}

test('default export ignores malformed environment records that are outside its selected scope', () => {
  const input = createFixture()
  input.envelopes.environments.data = [{ id: 'malformed-excluded-id', value: 'EXCLUDED_ENV_CANARY' }]
  const result = buildDefaultExportPackageFiles(input)
  assert.deepEqual(readJson(result, 'data/environments.json').data, [])
  assert.equal(readAllText(result).includes('EXCLUDED_ENV_CANARY'), false)
})

test('snapshots stateful options and isolates script reads from mutable source metadata', () => {
  const input = createFixture()
  let environmentReads = 0
  Object.defineProperty(input.options, 'includeEnvironments', {
    enumerable: true,
    get() { environmentReads += 1; return environmentReads === 1 }
  })
  const originalReader = input.readScriptContent
  const originalHash = input.envelopes.scripts.data[0].contentHash
  input.readScriptContent = (script) => {
    script.managedFileName = '../parameter-escape.js'
    input.envelopes.scripts.data[0].managedFileName = '../closure-escape.js'
    input.envelopes.scripts.data[0].contentHash = sha256('callback-mutated-content')
    input.envelopes.scripts.data[0].language = 'python'
    input.envelopes.tasks.data[0].interpreter.kind = 'python'
    input.envelopes.scripts.schemaVersion = 999
    input.envelopes.tasks.schemaVersion = 999
    input.envelopes.environments.schemaVersion = 999
    input.envelopes.settings.schemaVersion = 999
    return originalReader(script)
  }
  const result = buildExportPackageFiles(input)
  assert.equal(result.manifest.options.includeEnvironments, true)
  assert.equal(result.manifest.entities.environments, 2)
  assert.equal(readJson(result, 'data/scripts.json').data[0].contentHash, originalHash)
  assert.equal(readJson(result, 'data/scripts.json').data[0].language, 'javascript')
  assert.equal(readJson(result, 'data/tasks.json').data[0].interpreter.kind, 'javascript')
  for (const dataPath of ['data/scripts.json', 'data/tasks.json', 'data/environments.json', 'data/settings.json']) {
    assert.equal(readJson(result, dataPath).schemaVersion, 1)
  }
  assert.ok(result.files.some((file) => file.path === `scripts/${IDS.script}.js`))
  assert.equal(result.files.some((file) => file.path.includes('..')), false)
})

test('creates independent fail-closed options and enforces them through the default package entry', () => {
  const firstOptions = createDefaultExportOptions()
  assert.deepEqual(firstOptions, {
    includeEnvironments: false,
    includeEnvironmentValues: false,
    includeSensitiveValues: false
  })
  firstOptions.includeEnvironments = true
  assert.notStrictEqual(createDefaultExportOptions(), firstOptions)
  assert.equal(createDefaultExportOptions().includeEnvironments, false)

  const result = buildDefaultExportPackageFiles(createFixture({
    options: { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: true }
  }))
  assert.deepEqual(result.manifest.options, createDefaultExportOptions())
  assert.equal(result.manifest.entities.environments, 0)
  assert.deepEqual(readJson(result, 'data/environments.json').data, [])
  const allText = readAllText(result)
  for (const environmentValue of ['OUTPUT_MODE', '普通值', 'SECRET_TOKEN', 'sensitive-plaintext-fixture']) {
    assert.equal(allText.includes(environmentValue), false, `default export leaked ${environmentValue}`)
  }
  assert.equal(readJson(result, 'data/scripts.json').data.length, 1)
  assert.equal(readJson(result, 'data/tasks.json').data.length, 1)
})

test('builds the fixed versioned package structure with matching hashes, sizes, and counts', () => {
  const result = buildExportPackageFiles(createFixture())
  assert.deepEqual(result.files.map((file) => file.path), [
    'manifest.json',
    'data/environments.json',
    'data/scripts.json',
    'data/settings.json',
    'data/tasks.json',
    `scripts/${IDS.script}.js`
  ])
  assert.equal(result.manifest.formatVersion, '1.0')
  assert.deepEqual(result.manifest.entities, { scripts: 1, tasks: 1, environments: 2 })
  assert.equal(result.manifest.files.some((file) => file.path === 'manifest.json'), false)
  assert.deepEqual(result.manifest.files.map((file) => file.path), result.files.slice(1).map((file) => file.path))
  for (const entry of result.manifest.files) {
    const file = result.files.find((item) => item.path === entry.path)
    assert.equal(entry.sha256, sha256(file.content))
    assert.equal(entry.size, file.content.length)
  }
  for (const file of result.files.filter((item) => item.path.endsWith('.json'))) {
    assert.equal(file.content.at(-1), 10)
  }
  assert.equal(readJson(result, 'data/scripts.json').schemaVersion, 1)
  assert.equal(result.manifest.files.find((file) => file.path === `scripts/${IDS.script}.js`).size, Buffer.byteLength(SCRIPT_CONTENT))
})

test('represents all four environment export states without inferring inclusion from an empty value', () => {
  const omitted = buildExportPackageFiles(createFixture({
    options: { includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false }
  }))
  assert.deepEqual(readJson(omitted, 'data/environments.json').data, [])
  assert.equal(omitted.manifest.entities.environments, 0)

  const definitions = buildExportPackageFiles(createFixture())
  assert.deepEqual(
    readJson(definitions, 'data/environments.json').data.map((item) => [item.value, item.valueIncluded]),
    [['', false], ['', false]]
  )

  const ordinaryValues = buildExportPackageFiles(createFixture({
    options: { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: false }
  }))
  assert.deepEqual(
    readJson(ordinaryValues, 'data/environments.json').data.map((item) => [item.value, item.valueIncluded]),
    [['普通值', true], ['', false]]
  )
  assert.equal(readAllText(ordinaryValues).includes('sensitive-plaintext-fixture'), false)

  const allValues = buildExportPackageFiles(createFixture({
    options: { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: true }
  }))
  assert.deepEqual(
    readJson(allValues, 'data/environments.json').data.map((item) => [item.valueIncluded]),
    [[true], [true]]
  )
  assert.equal(readAllText(allValues).includes('sensitive-plaintext-fixture'), true)
  assert.equal(allValues.manifest.options.includeSensitiveValues, true)
})

test('uses exact protocol keys and ignores future local, runtime, and log fields', () => {
  const input = createFixture()
  Object.assign(input.envelopes.scripts.data[0], {
    sourceAbsolutePath: 'CANARY_SCRIPT_SOURCE_PATH',
    editorState: 'CANARY_EDITOR_STATE'
  })
  Object.assign(input.envelopes.tasks.data[0], {
    status: 'CANARY_RUNNING_STATUS',
    pid: 'CANARY_PID',
    activeRuns: 'CANARY_ACTIVE_RUNS',
    runRecords: 'CANARY_RUN_RECORDS',
    logFileName: 'CANARY_LOG_FILE',
    logPath: 'CANARY_LOG_PATH',
    resolvedScriptPath: 'CANARY_RESOLVED_SCRIPT_PATH',
    readiness: 'CANARY_READINESS',
    nextRunAt: 'CANARY_NEXT_RUN',
    activeRunCount: 'CANARY_ACTIVE_COUNT'
  })
  Object.assign(input.envelopes.environments.data[0], {
    lastRevealedAt: 'CANARY_REVEALED_AT',
    deviceSourcePath: 'CANARY_ENV_SOURCE_PATH'
  })
  Object.assign(input.envelopes.settings.data, {
    futureDevicePath: 'CANARY_FUTURE_DEVICE_PATH',
    runtimeState: 'CANARY_RUNTIME_STATE',
    machineId: 'CANARY_MACHINE_ID'
  })
  Object.assign(input.envelopes, {
    runRecords: { schemaVersion: 1, data: ['CANARY_TOP_RUN_RECORDS'] },
    activeRuns: ['CANARY_TOP_ACTIVE_RUNS'],
    logs: ['CANARY_TOP_LOGS']
  })
  input.runRecords = ['CANARY_INPUT_RUN_RECORDS']
  input.activeRuns = ['CANARY_INPUT_ACTIVE_RUNS']
  input.logs = ['CANARY_INPUT_LOGS']

  const result = buildExportPackageFiles(input)
  const script = readJson(result, 'data/scripts.json').data[0]
  const task = readJson(result, 'data/tasks.json').data[0]
  const environment = readJson(result, 'data/environments.json').data[0]
  const settings = readJson(result, 'data/settings.json').data
  assert.deepEqual(Object.keys(script), ['id', 'name', 'managedFileName', 'language', 'contentHash', 'note', 'createdAt', 'updatedAt'])
  assert.deepEqual(Object.keys(task), ['id', 'name', 'note', 'scriptId', 'interpreter', 'args', 'workingDirectory', 'cron', 'timeoutMs', 'enabled', 'concurrency', 'createdAt', 'updatedAt'])
  assert.deepEqual(Object.keys(task.interpreter), ['kind', 'executable'])
  assert.deepEqual(Object.keys(task.concurrency), ['policy', 'limit'])
  assert.deepEqual(Object.keys(environment), ['id', 'name', 'value', 'valueIncluded', 'note', 'scope', 'taskId', 'enabled', 'sensitive', 'createdAt', 'updatedAt'])
  assert.deepEqual(Object.keys(settings), ['defaultTimeoutMs', 'defaultConcurrency', 'logRetention', 'updatedAt'])
  assert.deepEqual(Object.keys(settings.defaultConcurrency), ['policy', 'limit'])
  assert.deepEqual(Object.keys(settings.logRetention), ['maxRunsPerTask', 'maxAgeDays'])
  assert.deepEqual(result.files.map((file) => file.path), [
    'manifest.json',
    'data/environments.json',
    'data/scripts.json',
    'data/settings.json',
    'data/tasks.json',
    `scripts/${IDS.script}.js`
  ])
  const allText = readAllText(result)
  assert.equal(allText.includes('CANARY_'), false)
  assert.equal(result.files.some((file) => file.path.includes('run-records') || file.path.startsWith('logs/') || file.path.includes('active-runs') || file.path.startsWith('backups/')), false)
})

test('preserves user-authored paths while clearing structured device configuration', () => {
  const sourcePath = '/user-authored/source/path'
  const argumentPath = '/user-authored/argument/path'
  const notePath = 'C:\\user-authored\\note-path'
  const content = `console.log(${JSON.stringify(sourcePath)})\n`
  const input = createFixture({ readScriptContent: () => content })
  input.envelopes.scripts.data[0].contentHash = sha256(content)
  input.envelopes.scripts.data[0].note = notePath
  input.envelopes.tasks.data[0].args.push(argumentPath)
  input.envelopes.tasks.data[0].note = notePath
  const result = buildDefaultExportPackageFiles(input)
  const task = readJson(result, 'data/tasks.json').data[0]
  assert.equal(result.files.find((file) => file.path.startsWith('scripts/')).content.toString('utf8'), content)
  assert.equal(readJson(result, 'data/scripts.json').data[0].note, notePath)
  assert.equal(task.note, notePath)
  assert.equal(task.args.includes(argumentPath), true)
  assert.equal(task.interpreter.executable, null)
  assert.equal(task.workingDirectory, null)
})

test('projects tasks and shared settings without device-local execution state', () => {
  const result = buildExportPackageFiles(createFixture())
  const task = readJson(result, 'data/tasks.json').data[0]
  const settings = readJson(result, 'data/settings.json').data
  assert.deepEqual(task.interpreter, { kind: 'javascript', executable: null })
  assert.equal(task.workingDirectory, null)
  assert.deepEqual(settings, {
    defaultTimeoutMs: 300000,
    defaultConcurrency: { policy: 'limited', limit: 2 },
    logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 },
    updatedAt: '2026-07-11T00:00:00.000Z'
  })
  const allText = readAllText(result)
  for (const localValue of ['/device/bin/node-private', '/device/private/workspace', '/device/default/node', '/device/default/workspace', 'schedulerNoticeAcknowledged', 'runRecords', 'logFileName', 'pid']) {
    assert.equal(allText.includes(localValue), false, `leaked ${localValue}`)
  }
})

test('produces identical bytes for equivalent snapshots with different entity and key insertion order', () => {
  const firstInput = createFixture()
  const first = buildExportPackageFiles(firstInput)
  const reverseKeys = (value) => Object.fromEntries(Object.entries(value).reverse())
  const secondInput = createFixture()
  secondInput.envelopes.scripts.data = secondInput.envelopes.scripts.data.map(reverseKeys).reverse()
  secondInput.envelopes.tasks.data = secondInput.envelopes.tasks.data.map(reverseKeys).reverse()
  secondInput.envelopes.environments.data = secondInput.envelopes.environments.data.map(reverseKeys).reverse()
  secondInput.envelopes.settings.data = reverseKeys(secondInput.envelopes.settings.data)
  const second = buildExportPackageFiles(secondInput)
  assert.deepEqual(second.files.map((file) => [file.path, file.content]), first.files.map((file) => [file.path, file.content]))
})

test('uses controlled extensions for every supported script language instead of display names', () => {
  const languages = [
    ['javascript', 'js'],
    ['python', 'py'],
    ['powershell', 'ps1'],
    ['shell', 'sh']
  ]
  for (const [language, extension] of languages) {
    const input = createFixture()
    input.envelopes.scripts.data[0].language = language
    input.envelopes.scripts.data[0].managedFileName = `${IDS.script}.${extension}`
    input.envelopes.scripts.data[0].name = '../unsafe-name'
    input.envelopes.tasks.data[0].interpreter.kind = language
    const result = buildExportPackageFiles(input)
    assert.ok(result.files.some((file) => file.path === `scripts/${IDS.script}.${extension}`))
    assert.equal(result.files.some((file) => file.path.includes('unsafe-name')), false)
  }
})

test('rejects invalid option implications and malformed package metadata', () => {
  for (const options of [
    { includeEnvironments: false, includeEnvironmentValues: true, includeSensitiveValues: false },
    { includeEnvironments: true, includeEnvironmentValues: false, includeSensitiveValues: true },
    { includeEnvironmentValues: false, includeSensitiveValues: false }
  ]) {
    assert.throws(() => buildExportPackageFiles(createFixture({ options })), error => error.code === 'VALIDATION_ERROR')
  }
  assert.throws(() => buildExportPackageFiles({ ...createFixture(), options: undefined }), error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => buildExportPackageFiles(createFixture({ appVersion: 'version-one' })), error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => buildExportPackageFiles(createFixture({ appVersion: '1.0.0-01' })), error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => buildExportPackageFiles(createFixture({ exportedAt: '2026-07-12' })), error => error.code === 'VALIDATION_ERROR')
})

test('rejects unsupported envelope versions and malformed required entity fields', () => {
  const futureVersion = createFixture()
  futureVersion.envelopes.scripts.schemaVersion = 999
  assert.throws(() => buildExportPackageFiles(futureVersion), error => error.code === 'UNSUPPORTED_DATA_VERSION')

  const malformedInputs = [
    (input) => { input.envelopes.scripts.data[0].name = undefined },
    (input) => { input.envelopes.scripts.data[0].createdAt = 'not-a-date' },
    (input) => { input.envelopes.tasks.data[0].interpreter = null },
    (input) => { input.envelopes.tasks.data[0].args = 42 },
    (input) => { input.envelopes.tasks.data[0].concurrency = null },
    (input) => { input.envelopes.tasks.data[0].args = ['ok', 42] },
    (input) => { input.envelopes.tasks.data[0].interpreter.kind = 'python' },
    (input) => { input.envelopes.tasks.data[0].args = Array.from({ length: 101 }, () => 'arg') },
    (input) => { input.envelopes.tasks.data[0].args = ['x'.repeat(2001)] },
    (input) => { input.envelopes.tasks.data[0].cron = 'not a cron' },
    (input) => { input.envelopes.tasks.data[0].timeoutMs = 999 },
    (input) => { input.envelopes.tasks.data[0].timeoutMs = 86400001 },
    (input) => { input.envelopes.tasks.data[0].enabled = 'yes' },
    (input) => { input.envelopes.environments.data[0].name = 'BAD-NAME' },
    (input) => { input.envelopes.environments.data[0].value = 'x'.repeat(10001) },
    (input) => { input.envelopes.environments.data[0].sensitive = 'false' },
    (input) => { input.envelopes.settings.data.defaultTimeoutMs = 999 },
    (input) => { input.envelopes.settings.data.defaultTimeoutMs = 86400001 },
    (input) => { input.envelopes.settings.data.updatedAt = 'invalid' }
  ]
  for (const corrupt of malformedInputs) {
    const input = createFixture()
    corrupt(input)
    assert.throws(() => buildExportPackageFiles(input), error => error.code === 'DATA_CORRUPTED')
  }
})

test('rejects duplicate IDs, dangling references, environment conflicts, and invalid managed filenames', () => {
  const corruptions = [
    (input) => input.envelopes.scripts.data.push({ ...input.envelopes.scripts.data[0] }),
    (input) => { input.envelopes.tasks.data[0].scriptId = '123e4567-e89b-42d3-a456-426614174099' },
    (input) => { input.envelopes.environments.data[1].taskId = '123e4567-e89b-42d3-a456-426614174099' },
    (input) => { input.envelopes.environments.data[1] = { ...input.envelopes.environments.data[0], id: IDS.sensitiveEnvironment } },
    (input) => { input.envelopes.scripts.data[0].managedFileName = '../escape.js' }
  ]
  for (const corrupt of corruptions) {
    const input = createFixture()
    corrupt(input)
    assert.throws(() => buildExportPackageFiles(input), error => error.code === 'DATA_CORRUPTED')
  }
})

test('rejects mismatched or unreadable managed script content without returning a partial package', () => {
  assert.throws(
    () => buildExportPackageFiles(createFixture({ readScriptContent: () => 'changed content' })),
    error => error.code === 'DATA_CORRUPTED'
  )
  const input = createFixture({
    readScriptContent() {
      const error = new Error('missing')
      error.code = 'SCRIPT_MISSING'
      throw error
    }
  })
  assert.throws(() => buildExportPackageFiles(input), error => error.code === 'SCRIPT_MISSING')
})
