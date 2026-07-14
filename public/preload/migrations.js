'use strict'

const { RepositoryError } = require('./metadata-repository')

/** Ensures a migration function returns the exact next version and a serializable data payload. */
function validateMigrationResult(result, expectedVersion, repositoryName) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new RepositoryError('MIGRATION_FAILED', `${repositoryName} 的迁移结果格式无效`)
  }
  if (result.schemaVersion !== expectedVersion || !Object.hasOwn(result, 'data')) {
    throw new RepositoryError(
      'MIGRATION_FAILED',
      `${repositoryName} 的迁移必须生成 schemaVersion ${expectedVersion}`
    )
  }
  return result
}

class MigrationRegistry {
  /** Creates an empty per-repository registry; migrations must be explicitly registered by source version. */
  constructor() {
    this.migrations = new Map()
  }

  /** Registers one deterministic migration from version N to N+1 and rejects duplicate steps. */
  register(repositoryName, fromVersion, migrate) {
    if (typeof repositoryName !== 'string' || repositoryName.length === 0) {
      throw new TypeError('repositoryName 不能为空')
    }
    if (!Number.isInteger(fromVersion) || fromVersion < 0) {
      throw new TypeError('fromVersion 必须是非负整数')
    }
    if (typeof migrate !== 'function') throw new TypeError('migrate 必须是函数')

    const key = `${repositoryName}:${fromVersion}`
    if (this.migrations.has(key)) {
      throw new TypeError(`${repositoryName} 的版本 ${fromVersion} 迁移已注册`)
    }
    this.migrations.set(key, migrate)
    return this
  }

  /** Reports whether a repository has one migration step beginning at the requested version. */
  has(repositoryName, fromVersion) {
    return this.migrations.has(`${repositoryName}:${fromVersion}`)
  }

  /**
   * Applies every N→N+1 step until targetVersion, cloning the source so migrations cannot mutate
   * the original parsed document that remains available for diagnostics and recovery.
   */
  migrate(repositoryName, envelope, targetVersion) {
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      throw new TypeError('targetVersion 必须是非负整数')
    }
    if (envelope.schemaVersion > targetVersion) {
      throw new RepositoryError(
        'UNSUPPORTED_DATA_VERSION',
        `${repositoryName} 的数据版本高于当前支持版本`
      )
    }

    let current
    try {
      current = structuredClone(envelope)
    } catch (error) {
      throw new RepositoryError('MIGRATION_FAILED', `${repositoryName} 无法复制待迁移数据`, error)
    }

    while (current.schemaVersion < targetVersion) {
      const fromVersion = current.schemaVersion
      const migration = this.migrations.get(`${repositoryName}:${fromVersion}`)
      if (!migration) {
        throw new RepositoryError(
          'MIGRATION_FAILED',
          `${repositoryName} 缺少 ${fromVersion} → ${fromVersion + 1} 迁移`
        )
      }
      try {
        current = validateMigrationResult(
          migration(structuredClone(current)),
          fromVersion + 1,
          repositoryName
        )
      } catch (error) {
        if (error instanceof RepositoryError) throw error
        throw new RepositoryError(
          'MIGRATION_FAILED',
          `${repositoryName} 的 ${fromVersion} → ${fromVersion + 1} 迁移失败`,
          error
        )
      }
    }
    return current
  }
}

/** Creates the application's migration registry; schema v1 is the baseline and needs no steps yet. */
function createMigrationRegistry() {
  return new MigrationRegistry()
}

module.exports = {
  MigrationRegistry,
  createMigrationRegistry,
  validateMigrationResult
}
