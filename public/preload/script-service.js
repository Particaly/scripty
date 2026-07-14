'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { RepositoryError } = require('./metadata-repository')
const { invoke } = require('./task-service')

const IMPORT_TOKEN_TTL_MS = 5 * 60 * 1000
const EXTENSION_LANGUAGES = Object.freeze({
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.ps1': 'powershell',
  '.sh': 'shell'
})

/** Normalizes ZTools dialog results across synchronous and promise-based host versions. */
async function chooseFile(ztools) {
  return await ztools.showOpenDialog({
    title: '选择要导入的本地脚本',
    properties: ['openFile'],
    filters: [{ name: '脚本文件', extensions: ['js', 'mjs', 'cjs', 'py', 'ps1', 'sh'] }]
  })
}

/** Infers a supported script language strictly from an allowlisted file extension. */
function detectLanguage(filePath) {
  return EXTENSION_LANGUAGES[path.extname(filePath).toLocaleLowerCase()] ?? null
}

/** Builds a token-gated script import API that never returns selected absolute paths to the renderer. */
function createScriptsApi(metadataRepository, managedScriptRepository, ztools, now = () => Date.now()) {
  const selections = new Map()

  /** Removes expired selections before issuing or consuming tokens to bound retained path data. */
  function removeExpiredSelections() {
    const currentTime = now()
    for (const [token, selection] of selections) {
      if (selection.expiresAt <= currentTime) selections.delete(token)
    }
  }

  return {
    /** Returns script metadata summaries, optionally filtered by normalized search text and language. */
    list(query = {}) {
      return invoke(() => {
        const search = typeof query.search === 'string' ? query.search.trim().toLocaleLowerCase() : ''
        return metadataRepository.read('scripts')
          .filter(script => !query.language || script.language === query.language)
          .filter(script => !search || `${script.name} ${script.note}`.toLocaleLowerCase().includes(search))
          .map(({ contentHash, ...summary }) => summary)
      })
    },

    /** Returns one managed script together with its current UTF-8 source text. */
    get(id) {
      return invoke(() => {
        const script = metadataRepository.read('scripts').find(item => item.id === id)
        if (!script) throw new RepositoryError('NOT_FOUND', '脚本不存在')
        return { ...script, content: managedScriptRepository.read(script.id, script.language) }
      })
    },

    /** Creates a new managed source file and rolls it back if metadata persistence fails. */
    create(input) {
      return invoke(() => {
        const name = typeof input?.name === 'string' ? input.name.trim() : ''
        const language = input?.language
        const content = typeof input?.content === 'string' ? input.content : null
        if (!name || name.length > 100 || !Object.values(EXTENSION_LANGUAGES).includes(language) || content === null) {
          throw new RepositoryError('VALIDATION_ERROR', '脚本名称、语言或源码无效')
        }
        const id = randomUUID()
        const stored = managedScriptRepository.write(id, language, content)
        const timestamp = new Date(now()).toISOString()
        const script = { id, name, managedFileName: stored.managedFileName, language, contentHash: stored.contentHash, note: typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '', createdAt: timestamp, updatedAt: timestamp }
        try {
          metadataRepository.write('scripts', [...metadataRepository.read('scripts'), script])
        } catch (error) {
          managedScriptRepository.remove(id, language)
          throw error
        }
        return { ...script, content }
      })
    },

    /** Atomically updates source and metadata, restoring the previous source if metadata persistence fails. */
    update(id, input) {
      return invoke(() => {
        const scripts = metadataRepository.read('scripts')
        const index = scripts.findIndex(script => script.id === id)
        if (index < 0) throw new RepositoryError('NOT_FOUND', '脚本不存在')
        const previous = scripts[index]
        const name = typeof input?.name === 'string' ? input.name.trim() : ''
        const language = input?.language
        const content = typeof input?.content === 'string' ? input.content : null
        if (!name || name.length > 100 || language !== previous.language || content === null) {
          throw new RepositoryError('VALIDATION_ERROR', '脚本名称、语言或源码无效；已有脚本不能更改语言')
        }
        const previousContent = managedScriptRepository.read(id, previous.language)
        const stored = managedScriptRepository.write(id, language, content)
        const updated = { ...previous, name, note: typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '', contentHash: stored.contentHash, updatedAt: new Date(now()).toISOString() }
        const nextScripts = scripts.slice()
        nextScripts[index] = updated
        try {
          metadataRepository.write('scripts', nextScripts)
        } catch (error) {
          managedScriptRepository.write(id, previous.language, previousContent)
          throw error
        }
        return { ...updated, content }
      })
    },

    /** Opens the host file picker and returns only display metadata plus a short-lived single-use token. */
    chooseImportFile() {
      return invoke(async () => {
        removeExpiredSelections()
        const files = await chooseFile(ztools)
        if (!Array.isArray(files) || files.length === 0) return null
        const filePath = path.resolve(files[0])
        const language = detectLanguage(filePath)
        if (!language) throw new RepositoryError('FILE_TYPE_NOT_ALLOWED', '请选择受支持的脚本文件')
        let stat
        try {
          stat = fs.statSync(filePath)
        } catch (error) {
          throw new RepositoryError('READ_FAILED', '无法读取所选脚本文件', error)
        }
        if (!stat.isFile()) throw new RepositoryError('FILE_TYPE_NOT_ALLOWED', '所选内容不是普通文件')
        if (stat.size > managedScriptRepository.maxScriptBytes) {
          throw new RepositoryError('FILE_TOO_LARGE', '所选脚本超过大小限制')
        }
        const selectionToken = randomUUID()
        selections.set(selectionToken, {
          filePath,
          language,
          size: stat.size,
          expiresAt: now() + IMPORT_TOKEN_TTL_MS
        })
        return {
          selectionToken,
          displayName: path.basename(filePath),
          detectedLanguage: language,
          size: stat.size
        }
      })
    },

    /** Consumes one valid selection token and copies source bytes into an independently managed script file. */
    importSelected(selectionToken, input) {
      return invoke(() => {
        removeExpiredSelections()
        const selection = selections.get(selectionToken)
        if (!selection) throw new RepositoryError('TOKEN_INVALID', '脚本选择已失效，请重新选择文件')
        selections.delete(selectionToken)
        const language = input?.language ?? selection.language
        if (!Object.values(EXTENSION_LANGUAGES).includes(language)) {
          throw new RepositoryError('VALIDATION_ERROR', '脚本语言无效')
        }
        const name = typeof input?.name === 'string' ? input.name.trim() : ''
        if (!name || name.length > 100) throw new RepositoryError('VALIDATION_ERROR', '脚本名称应为 1 到 100 个字符')
        let content
        try {
          const stat = fs.statSync(selection.filePath)
          if (!stat.isFile() || stat.size > managedScriptRepository.maxScriptBytes) {
            throw new RepositoryError('FILE_TOO_LARGE', '所选脚本已变化或超过大小限制')
          }
          content = fs.readFileSync(selection.filePath, 'utf8')
        } catch (error) {
          if (error instanceof RepositoryError) throw error
          throw new RepositoryError('READ_FAILED', '无法读取所选脚本文件', error)
        }
        const id = randomUUID()
        const stored = managedScriptRepository.write(id, language, content)
        const timestamp = new Date(now()).toISOString()
        const script = {
          id,
          name,
          managedFileName: stored.managedFileName,
          language,
          contentHash: stored.contentHash,
          note: typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '',
          createdAt: timestamp,
          updatedAt: timestamp
        }
        try {
          metadataRepository.write('scripts', [...metadataRepository.read('scripts'), script])
        } catch (error) {
          managedScriptRepository.remove(id, language)
          throw error
        }
        return { ...script, content }
      })
    }
  }
}

module.exports = {
  EXTENSION_LANGUAGES,
  IMPORT_TOKEN_TTL_MS,
  createScriptsApi,
  detectLanguage
}
