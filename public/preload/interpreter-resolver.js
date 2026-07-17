'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findExecutable } = require('./executable-finder')

const WINDOWS_DIRECT_EXTENSIONS = new Set(['.com', '.exe'])
const WINDOWS_SHELL_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1'])

/** Reads an environment variable using Windows' case-insensitive key semantics when needed. */
function readEnvironmentValue(environment, name, platform) {
  if (platform !== 'win32') return environment?.[name]
  const matchedKey = Object.keys(environment ?? {}).find(key => key.toLocaleLowerCase() === name.toLocaleLowerCase())
  return matchedKey ? environment[matchedKey] : undefined
}

/** Returns whether a candidate is a runnable regular file without resolving symlinks to a different launch path. */
function isRunnableFile(candidate, platform, fileSystem) {
  try {
    if (!fileSystem.statSync(candidate).isFile()) return false
    if (platform !== 'win32') fileSystem.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Rejects relative path-like values so only absolute paths and PATH-resolved command names can execute. */
function isBareCommand(executable, pathApi) {
  return executable !== '.' && executable !== '..' && !executable.includes('/') && !executable.includes('\\') && !pathApi.isAbsolute(executable)
}

/** Builds Windows command variants that can be launched directly while shell execution remains disabled. */
function getWindowsCommandNames(executable, environment) {
  const explicitExtension = path.win32.extname(executable).toLocaleLowerCase()
  if (explicitExtension) return WINDOWS_DIRECT_EXTENSIONS.has(explicitExtension) ? [executable] : []
  const configured = readEnvironmentValue(environment, 'PATHEXT', 'win32')
  const extensions = typeof configured === 'string' && configured.trim()
    ? configured.split(';').map(extension => extension.trim()).filter(Boolean)
    : ['.COM', '.EXE']
  return extensions
    .map(extension => extension.startsWith('.') ? extension : `.${extension}`)
    .filter(extension => WINDOWS_DIRECT_EXTENSIONS.has(extension.toLocaleLowerCase()))
    .map(extension => `${executable}${extension}`)
}

/** Searches the trusted host PATH in order and returns the first runnable absolute candidate. */
function resolveFromPath(executable, platform, environment, fileSystem) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!isBareCommand(executable, pathApi)) return null
  const configuredPath = readEnvironmentValue(environment, 'PATH', platform)
  if (typeof configuredPath !== 'string' || !configuredPath) return null
  const commandNames = platform === 'win32'
    ? getWindowsCommandNames(executable, environment)
    : [executable]
  for (const directory of configuredPath.split(pathApi.delimiter)) {
    if (!directory) continue
    for (const commandName of commandNames) {
      const candidate = pathApi.resolve(directory, commandName)
      if (isRunnableFile(candidate, platform, fileSystem)) return candidate
    }
  }
  return null
}

/** Resolves the supported macOS mise Node runtime, preferring its standalone installed binary over the dispatch shim. */
function resolveMiseNode(kind, executable, platform, environment, homeDirectory, fileSystem) {
  if (platform !== 'darwin' || kind !== 'javascript' || executable !== 'node') return null
  const configuredDataDirectory = readEnvironmentValue(environment, 'MISE_DATA_DIR', platform)
  const xdgDataDirectory = readEnvironmentValue(environment, 'XDG_DATA_HOME', platform)
  const dataDirectory = typeof configuredDataDirectory === 'string' && path.posix.isAbsolute(configuredDataDirectory)
    ? configuredDataDirectory
    : typeof xdgDataDirectory === 'string' && path.posix.isAbsolute(xdgDataDirectory)
      ? path.posix.join(xdgDataDirectory, 'mise')
      : path.posix.join(homeDirectory, '.local', 'share', 'mise')
  const installedNode = path.posix.join(dataDirectory, 'installs', 'node', 'latest', 'bin', 'node')
  if (isRunnableFile(installedNode, platform, fileSystem)) {
    try {
      const resolvedNode = fileSystem.realpathSync(installedNode)
      const installsDirectory = path.posix.join(dataDirectory, 'installs', 'node')
      const relativeTarget = path.posix.relative(installsDirectory, resolvedNode)
      if (relativeTarget && !relativeTarget.startsWith('..') && !path.posix.isAbsolute(relativeTarget) && isRunnableFile(resolvedNode, platform, fileSystem)) return resolvedNode
    } catch {}
  }
  const shim = path.posix.join(dataDirectory, 'shims', 'node')
  return isRunnableFile(shim, platform, fileSystem) ? shim : null
}

/**
 * 通用的可执行文件查找（异步）
 * 使用新的通用查找器，支持跨平台一致的查找逻辑
 */
async function resolveExecutableAsync(executable, platform, environment, homeDirectory) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!isBareCommand(executable, pathApi)) return null

  return await findExecutable(executable, {
    platform,
    environment,
    homeDirectory
  })
}

/**
 * Creates a deterministic interpreter resolver for preload readiness checks and process launches.
 * Explicit paths are authoritative; bare commands use the host PATH before the macOS mise Node fallback.
 */
function createInterpreterResolver({
  platform = process.platform,
  environment = process.env,
  homeDirectory = os.homedir(),
  fileSystem = fs
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix

  return {
    /** Returns a runnable absolute path for the configured interpreter, or null when no safe candidate exists. */
    resolve(kind, configuredExecutable) {
      if (typeof configuredExecutable !== 'string') return null
      const executable = configuredExecutable.trim()
      if (!executable) return null
      if (pathApi.isAbsolute(executable)) {
        if (platform === 'win32' && WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(executable).toLocaleLowerCase())) return null
        return isRunnableFile(executable, platform, fileSystem) ? executable : null
      }
      if (!isBareCommand(executable, pathApi)) return null
      return resolveFromPath(executable, platform, environment, fileSystem)
        ?? resolveMiseNode(kind, executable, platform, environment, homeDirectory, fileSystem)
    },

    /**
     * 异步解析解释器路径（使用通用查找器）
     * 适用于需要更可靠查找的场景（如通过登录 shell 或 where.exe）
     * @param {string} kind - 语言类型 ('javascript' 或 'python')
     * @param {string} configuredExecutable - 配置的可执行文件名或路径
     * @returns {Promise<string|null>} 可执行文件的绝对路径，未找到时返回 null
     */
    async resolveAsync(kind, configuredExecutable) {
      if (typeof configuredExecutable !== 'string') return null
      const executable = configuredExecutable.trim()
      if (!executable) return null

      // 处理绝对路径
      if (pathApi.isAbsolute(executable)) {
        if (platform === 'win32' && WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(executable).toLocaleLowerCase())) return null
        return isRunnableFile(executable, platform, fileSystem) ? executable : null
      }

      // 处理相对路径（不允许）
      if (!isBareCommand(executable, pathApi)) return null

      // 先尝试通用异步查找器（更可靠）
      const asyncResult = await resolveExecutableAsync(executable, platform, environment, homeDirectory)
      if (asyncResult) return asyncResult

      // 回退到同步方法
      return resolveFromPath(executable, platform, environment, fileSystem)
        ?? resolveMiseNode(kind, executable, platform, environment, homeDirectory, fileSystem)
    }
  }
}

module.exports = {
  createInterpreterResolver,
  getWindowsCommandNames,
  isBareCommand,
  isRunnableFile,
  readEnvironmentValue,
  resolveFromPath,
  resolveMiseNode,
  resolveExecutableAsync
}
