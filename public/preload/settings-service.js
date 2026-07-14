'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { RepositoryError } = require('./metadata-repository')
const { invoke } = require('./task-service')

const LANGUAGES = ['javascript', 'python', 'powershell', 'shell']
const SELECTION_TTL_MS = 5 * 60 * 1000

/** Validates one supported language at the preload boundary. */
function assertLanguage(language) {
  if (!LANGUAGES.includes(language)) throw new RepositoryError('VALIDATION_ERROR', '脚本语言无效')
}

/** Builds device-local settings operations, including token-gated interpreter file selection. */
function createSettingsApi(metadataRepository, ztools, now = () => Date.now()) {
  const selections = new Map()

  /** Removes expired interpreter selections so absolute paths remain in memory only briefly. */
  function removeExpiredSelections() {
    const timestamp = now()
    for (const [token, selection] of selections) {
      if (selection.expiresAt <= timestamp) selections.delete(token)
    }
  }

  return {
    /** Returns the current device settings singleton. */
    get() {
      return invoke(() => metadataRepository.read('settings'))
    },

    /** Updates device defaults after normalizing every interpreter value to a string or null. */
    update(input) {
      return invoke(() => {
        const current = metadataRepository.read('settings')
        const interpreters = {}
        for (const language of LANGUAGES) {
          const value = input?.defaultInterpreters?.[language]
          interpreters[language] = typeof value === 'string' && value.trim() ? value.trim() : null
        }
        const updated = {
          ...current,
          ...input,
          defaultInterpreters: interpreters,
          updatedAt: new Date(now()).toISOString()
        }
        metadataRepository.write('settings', updated)
        return updated
      })
    },

    /** Opens a host executable picker and returns only a display name plus a short-lived token. */
    chooseInterpreter(language) {
      return invoke(async () => {
        assertLanguage(language)
        removeExpiredSelections()
        const files = await ztools.showOpenDialog({
          title: '选择解释器可执行文件',
          properties: ['openFile']
        })
        if (!Array.isArray(files) || files.length === 0) return null
        const executable = path.resolve(files[0])
        let stat
        try {
          stat = fs.statSync(executable)
        } catch (error) {
          throw new RepositoryError('READ_FAILED', '无法读取所选解释器', error)
        }
        if (!stat.isFile()) throw new RepositoryError('INTERPRETER_UNAVAILABLE', '所选解释器不是普通文件')
        const selectionToken = randomUUID()
        selections.set(selectionToken, { language, executable, expiresAt: now() + SELECTION_TTL_MS })
        return { selectionToken, displayName: path.basename(executable) }
      })
    },

    /** Consumes a selection token, verifies the file still exists, and saves it as the language default. */
    validateInterpreter(language, selectionToken) {
      return invoke(() => {
        assertLanguage(language)
        removeExpiredSelections()
        const selection = selections.get(selectionToken)
        if (!selection || selection.language !== language) {
          throw new RepositoryError('TOKEN_INVALID', '解释器选择已失效，请重新选择')
        }
        selections.delete(selectionToken)
        try {
          if (!fs.statSync(selection.executable).isFile()) throw new Error('not a file')
        } catch (error) {
          throw new RepositoryError('INTERPRETER_UNAVAILABLE', '所选解释器不可用', error)
        }
        const settings = metadataRepository.read('settings')
        settings.defaultInterpreters = { ...settings.defaultInterpreters, [language]: selection.executable }
        settings.updatedAt = new Date(now()).toISOString()
        metadataRepository.write('settings', settings)
        return { language, valid: true, version: null, message: '解释器文件可用' }
      })
    }
  }
}

module.exports = { LANGUAGES, SELECTION_TTL_MS, createSettingsApi }
