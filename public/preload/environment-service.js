'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { RepositoryError } = require('./metadata-repository')
const { invoke } = require('./task-service')

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validates environment input, references, and same-scope uniqueness before persistence. */
function normalizeEnvironmentInput(input, environments, tasks, currentId = null) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) throw new RepositoryError('VALIDATION_ERROR', '环境变量名称格式无效')
  const scope = input?.scope
  if (!['global', 'task'].includes(scope)) throw new RepositoryError('VALIDATION_ERROR', '环境变量作用域无效')
  const taskId = scope === 'task' ? input.taskId : null
  if (scope === 'task' && !tasks.some(task => task.id === taskId)) throw new RepositoryError('REFERENCE_CONFLICT', '任务级环境变量必须引用已存在任务')
  if (environments.some(variable => variable.id !== currentId && variable.name === name && variable.scope === scope && variable.taskId === taskId)) {
    throw new RepositoryError('NAME_CONFLICT', '同一作用域内已存在同名环境变量')
  }
  if (typeof input.value !== 'string' || input.value.length > 10000) throw new RepositoryError('VALIDATION_ERROR', '环境变量值无效或过长')
  return { name, value: input.value, note: typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '', scope, taskId, enabled: Boolean(input.enabled), sensitive: Boolean(input.sensitive) }
}

/** Removes raw values from ordinary list and mutation responses. */
function toSummary(variable) {
  const { value, ...summary } = variable
  return { ...summary, maskedValue: variable.sensitive ? '••••••••' : value }
}

/** Merges enabled variables in precedence order: system, global, then task-specific overrides. */
function buildTaskEnvironment(systemEnvironment, environments, taskId) {
  const result = { ...systemEnvironment }
  for (const variable of environments.filter(item => item.enabled && item.scope === 'global')) result[variable.name] = variable.value
  for (const variable of environments.filter(item => item.enabled && item.scope === 'task' && item.taskId === taskId)) result[variable.name] = variable.value
  return result
}

/** Parses basic dotenv assignments with quoted values while rejecting invalid names and duplicate keys. */
function parseDotEnv(content) {
  const entries = []
  const names = new Set()
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new RepositoryError('VALIDATION_ERROR', `.env 第 ${index + 1} 行格式无效`)
    if (names.has(match[1])) throw new RepositoryError('NAME_CONFLICT', `.env 包含重复变量 ${match[1]}`)
    names.add(match[1])
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    entries.push({ name: match[1], value })
  }
  return entries
}

/** Quotes one dotenv value when raw output could be parsed ambiguously. */
function formatDotEnvValue(value) {
  return /^[A-Za-z0-9_./:-]*$/.test(value) ? value : JSON.stringify(value)
}

/** Builds CRUD operations whose normal responses never expose sensitive plaintext values. */
function createEnvironmentsApi(metadataRepository, ztools = null) {
  const previews = new Map()
  return {
    /** Lists environment summaries with optional scope, task, enabled, and text filtering. */
    list(query = {}) {
      return invoke(() => {
        const search = typeof query.search === 'string' ? query.search.trim().toLocaleLowerCase() : ''
        return metadataRepository.read('environments')
          .filter(variable => !query.scope || variable.scope === query.scope)
          .filter(variable => !query.taskId || variable.taskId === query.taskId)
          .filter(variable => typeof query.enabled !== 'boolean' || variable.enabled === query.enabled)
          .filter(variable => !search || `${variable.name} ${variable.note}`.toLocaleLowerCase().includes(search))
          .map(toSummary)
      })
    },

    /** Returns one masked environment detail for edit-form metadata hydration. */
    get(id) {
      return invoke(() => {
        const variable = metadataRepository.read('environments').find(item => item.id === id)
        if (!variable) throw new RepositoryError('NOT_FOUND', '环境变量不存在')
        return toSummary(variable)
      })
    },

    /** Explicitly reveals one value; callers must gate this operation with user confirmation. */
    reveal(id) {
      return invoke(() => {
        const variable = metadataRepository.read('environments').find(item => item.id === id)
        if (!variable) throw new RepositoryError('NOT_FOUND', '环境变量不存在')
        return { id: variable.id, value: variable.value }
      })
    },

    /** Creates one validated environment variable with a generated UUID. */
    create(input) {
      return invoke(() => {
        const environments = metadataRepository.read('environments')
        const now = new Date().toISOString()
        const variable = { id: randomUUID(), ...normalizeEnvironmentInput(input, environments, metadataRepository.read('tasks')), createdAt: now, updatedAt: now }
        metadataRepository.write('environments', [...environments, variable])
        return toSummary(variable)
      })
    },

    /** Updates one environment variable while preserving identity and creation time. */
    update(id, input) {
      return invoke(() => {
        const environments = metadataRepository.read('environments')
        const index = environments.findIndex(variable => variable.id === id)
        if (index < 0) throw new RepositoryError('NOT_FOUND', '环境变量不存在')
        const updated = { ...environments[index], ...normalizeEnvironmentInput(input, environments, metadataRepository.read('tasks'), id), updatedAt: new Date().toISOString() }
        const next = environments.slice(); next[index] = updated
        metadataRepository.write('environments', next)
        return toSummary(updated)
      })
    },

    /** Atomically toggles one variable without requiring or exposing its current value. */
    setEnabled(id, enabled) {
      return invoke(() => {
        if (typeof enabled !== 'boolean') throw new RepositoryError('VALIDATION_ERROR', 'enabled 必须是布尔值')
        const environments = metadataRepository.read('environments')
        const index = environments.findIndex(variable => variable.id === id)
        if (index < 0) throw new RepositoryError('NOT_FOUND', '环境变量不存在')
        const updated = { ...environments[index], enabled, updatedAt: new Date().toISOString() }
        const next = environments.slice(); next[index] = updated
        metadataRepository.write('environments', next)
        return toSummary(updated)
      })
    },

    /** Selects and parses one dotenv file, returning a short-lived preview token rather than its path. */
    chooseDotEnvImport() {
      return invoke(async () => {
        if (!ztools) throw new RepositoryError('INTERNAL_ERROR', '宿主文件选择器不可用')
        const files = await ztools.showOpenDialog({ title: '选择 .env 文件', properties: ['openFile'], filters: [{ name: 'dotenv', extensions: ['env'] }] })
        if (!Array.isArray(files) || files.length === 0) return null
        const filePath = path.resolve(files[0])
        const stat = fs.statSync(filePath)
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new RepositoryError('FILE_TOO_LARGE', '.env 文件无效或过大')
        const entries = parseDotEnv(fs.readFileSync(filePath, 'utf8'))
        const token = randomUUID()
        previews.set(token, entries)
        const existing = new Set(metadataRepository.read('environments').map(variable => variable.name))
        return { previewToken: token, entries, conflicts: entries.filter(entry => existing.has(entry.name)).map(entry => entry.name) }
      })
    },

    /** Consumes a dotenv preview and atomically creates or overwrites variables in the selected scope. */
    importDotEnv(previewToken, input) {
      return invoke(() => {
        const entries = previews.get(previewToken)
        if (!entries) throw new RepositoryError('TOKEN_INVALID', '.env 预览已失效')
        previews.delete(previewToken)
        let environments = metadataRepository.read('environments')
        const tasks = metadataRepository.read('tasks')
        let created = 0, updated = 0, skipped = 0
        const now = new Date().toISOString()
        for (const entry of entries) {
          const taskId = input.scope === 'task' ? input.taskId : null
          const index = environments.findIndex(variable => variable.name === entry.name && variable.scope === input.scope && variable.taskId === taskId)
          if (index >= 0 && !input.overwriteExisting) { skipped += 1; continue }
          const normalized = normalizeEnvironmentInput({ ...entry, note: '', scope: input.scope, taskId, enabled: true, sensitive: Boolean(input.sensitive) }, environments, tasks, index >= 0 ? environments[index].id : null)
          if (index >= 0) { environments[index] = { ...environments[index], ...normalized, updatedAt: now }; updated += 1 }
          else { environments.push({ id: randomUUID(), ...normalized, createdAt: now, updatedAt: now }); created += 1 }
        }
        metadataRepository.write('environments', environments)
        return { created, updated, skipped, warnings: [] }
      })
    },

    /** Exports selected variables through a save dialog; sensitive values require explicit input confirmation. */
    exportDotEnv(input) {
      return invoke(async () => {
        if (!ztools) throw new RepositoryError('INTERNAL_ERROR', '宿主保存对话框不可用')
        const selected = metadataRepository.read('environments').filter(variable => (!input.scope || variable.scope === input.scope) && (!input.taskId || variable.taskId === input.taskId))
        if (selected.some(variable => variable.sensitive) && !input.includeSensitiveValues) {
          throw new RepositoryError('VALIDATION_ERROR', '导出包含敏感变量，必须显式确认')
        }
        const savePath = await ztools.showSaveDialog({ title: '导出 .env', defaultPath: 'scripty.env' })
        if (!savePath) return null
        const content = `${selected.map(variable => `${variable.name}=${formatDotEnvValue(variable.value)}`).join('\n')}\n`
        fs.writeFileSync(savePath, content, { encoding: 'utf8', mode: 0o600 })
        return { displayName: path.basename(savePath), size: Buffer.byteLength(content), containsSensitiveValues: selected.some(variable => variable.sensitive) }
      })
    },

    /** Deletes one environment variable by stable ID. */
    remove(id) {
      return invoke(() => {
        const environments = metadataRepository.read('environments')
        if (!environments.some(variable => variable.id === id)) throw new RepositoryError('NOT_FOUND', '环境变量不存在')
        metadataRepository.write('environments', environments.filter(variable => variable.id !== id))
      })
    }
  }
}

module.exports = { ENVIRONMENT_NAME_PATTERN, buildTaskEnvironment, createEnvironmentsApi, formatDotEnvValue, normalizeEnvironmentInput, parseDotEnv, toSummary }
