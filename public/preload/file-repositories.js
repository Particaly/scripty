'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { RepositoryError } = require('./metadata-repository')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SCRIPT_EXTENSIONS = Object.freeze({
  javascript: 'js',
  python: 'py',
  powershell: 'ps1',
  shell: 'sh'
})
const DEFAULT_MAX_SCRIPT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_LOG_CHUNK_BYTES = 256 * 1024

/** Rejects identifiers that could escape a fixed repository through path fragments. */
function assertEntityId(id, label) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new RepositoryError('INVALID_ID', `${label} 不是有效的 UUID`)
  }
}

/** Converts one supported language and script ID into the only permitted managed filename. */
function createManagedScriptFileName(scriptId, language) {
  assertEntityId(scriptId, '脚本 ID')
  const extension = SCRIPT_EXTENSIONS[language]
  if (!extension) throw new RepositoryError('VALIDATION_ERROR', '不支持的脚本语言')
  return `${scriptId}.${extension}`
}

/** Converts one run ID into its fixed log filename. */
function createLogFileName(runId) {
  assertEntityId(runId, '运行 ID')
  return `${runId}.log`
}

/** Calculates the lowercase SHA-256 used by script metadata and export validation. */
function calculateSha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Returns the largest prefix that ends on a complete UTF-8 character boundary. */
function getCompleteUtf8Length(buffer) {
  if (buffer.length === 0) return 0
  let leadIndex = buffer.length - 1
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) leadIndex -= 1
  if (leadIndex < 0) return 0

  const leadByte = buffer[leadIndex]
  let expectedLength = 1
  if ((leadByte & 0xe0) === 0xc0) expectedLength = 2
  else if ((leadByte & 0xf0) === 0xe0) expectedLength = 3
  else if ((leadByte & 0xf8) === 0xf0) expectedLength = 4
  return buffer.length - leadIndex < expectedLength ? leadIndex : buffer.length
}

/** Maps native file-system failures to the stable repository error vocabulary. */
function mapFileError(error, fallbackCode, message) {
  const codeBySystemError = {
    EACCES: 'PERMISSION_DENIED',
    EPERM: 'PERMISSION_DENIED',
    ENOSPC: 'DISK_FULL',
    ENOENT: 'SCRIPT_MISSING'
  }
  return new RepositoryError(codeBySystemError[error?.code] ?? fallbackCode, message, error)
}

/** Writes bytes through a same-directory temporary file before atomically replacing the target. */
function atomicWriteFile(filePath, content) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  let fileDescriptor
  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(fileDescriptor, content)
    fs.fsyncSync(fileDescriptor)
    fs.closeSync(fileDescriptor)
    fileDescriptor = undefined
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor)
      } catch {}
    }
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {}
    throw mapFileError(error, 'WRITE_FAILED', `无法写入 ${path.basename(filePath)}`)
  }
}

class ManagedScriptRepository {
  /** Creates a script repository rooted at Scripty's fixed managed scripts directory. */
  constructor(scriptsDirectory, maxScriptBytes = DEFAULT_MAX_SCRIPT_BYTES) {
    if (!path.isAbsolute(scriptsDirectory)) throw new TypeError('scriptsDirectory 必须是绝对路径')
    this.scriptsDirectory = scriptsDirectory
    this.maxScriptBytes = maxScriptBytes
  }

  /** Creates the managed scripts directory without touching existing source files. */
  initialize() {
    try {
      fs.mkdirSync(this.scriptsDirectory, { recursive: true })
    } catch (error) {
      throw mapFileError(error, 'WRITE_FAILED', '无法创建托管脚本目录')
    }
  }

  /** Resolves a script to its controlled path after regenerating the filename from ID and language. */
  getFilePath(scriptId, language) {
    return path.join(this.scriptsDirectory, createManagedScriptFileName(scriptId, language))
  }

  /** Atomically stores UTF-8 source and returns metadata needed by the Script entity. */
  write(scriptId, language, content) {
    if (typeof content !== 'string') {
      throw new RepositoryError('VALIDATION_ERROR', '脚本内容必须是字符串')
    }
    const size = Buffer.byteLength(content, 'utf8')
    if (size > this.maxScriptBytes) {
      throw new RepositoryError('FILE_TOO_LARGE', `脚本大小不能超过 ${this.maxScriptBytes} 字节`)
    }
    this.initialize()
    const managedFileName = createManagedScriptFileName(scriptId, language)
    atomicWriteFile(path.join(this.scriptsDirectory, managedFileName), Buffer.from(content, 'utf8'))
    return { managedFileName, contentHash: calculateSha256(content), size }
  }

  /** Reads one managed UTF-8 source file and reports a missing script distinctly. */
  read(scriptId, language) {
    const filePath = this.getFilePath(scriptId, language)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) throw new RepositoryError('SCRIPT_MISSING', '托管脚本不是普通文件')
      if (stat.size > this.maxScriptBytes) {
        throw new RepositoryError('FILE_TOO_LARGE', `脚本大小不能超过 ${this.maxScriptBytes} 字节`)
      }
      return fs.readFileSync(filePath, 'utf8')
    } catch (error) {
      if (error instanceof RepositoryError) throw error
      throw mapFileError(error, 'READ_FAILED', '无法读取托管脚本')
    }
  }

  /** Removes only the controlled source file for the requested script. */
  remove(scriptId, language) {
    try {
      fs.rmSync(this.getFilePath(scriptId, language), { force: true })
    } catch (error) {
      throw mapFileError(error, 'WRITE_FAILED', '无法删除托管脚本')
    }
  }

  /** Checks whether the controlled script path currently resolves to a regular file. */
  exists(scriptId, language) {
    try {
      return fs.statSync(this.getFilePath(scriptId, language)).isFile()
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw mapFileError(error, 'READ_FAILED', '无法检查托管脚本')
    }
  }
}

class LogFileRepository {
  /** Creates a log repository rooted at Scripty's fixed logs directory. */
  constructor(logsDirectory, maxChunkBytes = DEFAULT_MAX_LOG_CHUNK_BYTES) {
    if (!path.isAbsolute(logsDirectory)) throw new TypeError('logsDirectory 必须是绝对路径')
    this.logsDirectory = logsDirectory
    this.maxChunkBytes = maxChunkBytes
  }

  /** Creates the logs directory without modifying existing run output. */
  initialize() {
    try {
      fs.mkdirSync(this.logsDirectory, { recursive: true })
    } catch (error) {
      throw mapFileError(error, 'WRITE_FAILED', '无法创建日志目录')
    }
  }

  /** Resolves a run ID to its only permitted log path. */
  getFilePath(runId) {
    return path.join(this.logsDirectory, createLogFileName(runId))
  }

  /** Creates or truncates one run log before the process begins producing output. */
  create(runId) {
    this.initialize()
    const logFileName = createLogFileName(runId)
    atomicWriteFile(path.join(this.logsDirectory, logFileName), Buffer.alloc(0))
    return logFileName
  }

  /** Appends one UTF-8 log chunk and flushes it so history survives a later process failure. */
  append(runId, chunk) {
    const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    let fileDescriptor
    try {
      fileDescriptor = fs.openSync(this.getFilePath(runId), 'a', 0o600)
      fs.writeSync(fileDescriptor, content)
      fs.fsyncSync(fileDescriptor)
    } catch (error) {
      throw mapFileError(error, 'WRITE_FAILED', '无法追加运行日志')
    } finally {
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor)
    }
    return content.length
  }

  /**
   * Reads a bounded byte range from one run log.
   * Offsets are byte positions; the returned nextOffset can be sent back unchanged for pagination.
   * A chunk may exceed the requested length by at most three bytes when needed to return one complete UTF-8 character.
   */
  readChunk(runId, offset, length) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RepositoryError('VALIDATION_ERROR', '日志 offset 必须是非负整数')
    }
    if (!Number.isInteger(length) || length < 1 || length > this.maxChunkBytes) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        `日志 length 必须是 1 到 ${this.maxChunkBytes} 之间的整数`
      )
    }

    let fileDescriptor
    try {
      const filePath = this.getFilePath(runId)
      const size = fs.statSync(filePath).size
      if (offset > size) throw new RepositoryError('VALIDATION_ERROR', '日志 offset 超出文件范围')
      const readLength = Math.min(length, size - offset)
      const lookaheadLength = Math.min(readLength + 3, size - offset)
      const buffer = Buffer.alloc(lookaheadLength)
      fileDescriptor = fs.openSync(filePath, 'r')
      const bytesRead = fs.readSync(fileDescriptor, buffer, 0, lookaheadLength, offset)
      const candidate = buffer.subarray(0, Math.min(readLength, bytesRead))
      const completeLength = offset + readLength >= size
        ? candidate.length
        : getCompleteUtf8Length(candidate)
      if (completeLength === 0 && bytesRead > candidate.length) {
        const expandedLength = getCompleteUtf8Length(buffer.subarray(0, bytesRead))
        if (expandedLength > 0) {
          const nextOffset = offset + expandedLength
          return {
            content: buffer.subarray(0, expandedLength).toString('utf8'),
            offset,
            nextOffset,
            end: nextOffset >= size
          }
        }
      }
      const nextOffset = offset + completeLength
      return {
        content: candidate.subarray(0, completeLength).toString('utf8'),
        offset,
        nextOffset,
        end: nextOffset >= size
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error
      const mapped = mapFileError(error, 'READ_FAILED', '无法读取运行日志')
      if (mapped.code === 'SCRIPT_MISSING') mapped.code = 'NOT_FOUND'
      throw mapped
    } finally {
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor)
    }
  }

  /** Returns one controlled log's byte size for cleanup summaries without reading its contents. */
  getSize(runId) {
    try {
      return fs.statSync(this.getFilePath(runId)).size
    } catch (error) {
      const mapped = mapFileError(error, 'READ_FAILED', '无法读取运行日志大小')
      if (mapped.code === 'SCRIPT_MISSING') mapped.code = 'NOT_FOUND'
      throw mapped
    }
  }

  /** Removes only the controlled log file associated with one run. */
  remove(runId) {
    try {
      fs.rmSync(this.getFilePath(runId), { force: true })
    } catch (error) {
      throw mapFileError(error, 'WRITE_FAILED', '无法删除运行日志')
    }
  }
}

module.exports = {
  DEFAULT_MAX_LOG_CHUNK_BYTES,
  DEFAULT_MAX_SCRIPT_BYTES,
  LogFileRepository,
  ManagedScriptRepository,
  SCRIPT_EXTENSIONS,
  calculateSha256,
  createLogFileName,
  createManagedScriptFileName
}
