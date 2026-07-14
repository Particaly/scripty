'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createInterpreterResolver } = require('../public/preload/interpreter-resolver')

/** Creates a deterministic file-system probe for runnable paths and optional canonical symlink targets. */
function createFileSystem(runnablePaths, blockedPaths = [], realPaths = {}) {
  const runnable = new Set(runnablePaths)
  const blocked = new Set(blockedPaths)
  return {
    statSync(candidate) {
      if (!runnable.has(candidate) && !blocked.has(candidate)) throw new Error('missing')
      return { isFile: () => true }
    },
    accessSync(candidate) {
      if (!runnable.has(candidate) || blocked.has(candidate)) throw new Error('not executable')
    },
    realpathSync(candidate) {
      if (!runnable.has(candidate)) throw new Error('missing')
      return realPaths[candidate] ?? candidate
    }
  }
}

test('prefers an explicit absolute interpreter and never replaces a broken explicit choice', () => {
  const explicit = '/custom/node'
  const shim = '/home/user/.local/share/mise/shims/node'
  const available = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '' },
    homeDirectory: '/home/user',
    fileSystem: createFileSystem([explicit, shim])
  })
  assert.equal(available.resolve('javascript', explicit), explicit)

  const missing = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '' },
    homeDirectory: '/home/user',
    fileSystem: createFileSystem([shim])
  })
  assert.equal(missing.resolve('javascript', explicit), null)
})

test('resolves the first host PATH match before considering mise', () => {
  const resolver = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '/first:/second' },
    homeDirectory: '/home/user',
    fileSystem: createFileSystem(['/second/node', '/home/user/.local/share/mise/shims/node'])
  })
  assert.equal(resolver.resolve('javascript', 'node'), '/second/node')
})

test('prefers the standalone macOS mise Node installation when GUI PATH has no Node', () => {
  const alias = '/Users/test/.local/share/mise/installs/node/latest/bin/node'
  const installed = '/Users/test/.local/share/mise/installs/node/22.23.1/bin/node'
  const shim = '/Users/test/.local/share/mise/shims/node'
  const resolver = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '/usr/bin:/bin' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([alias, installed, shim], [], { [alias]: installed })
  })
  assert.equal(resolver.resolve('javascript', 'node'), installed)
})

test('falls back to the standard macOS mise Node shim when no standalone alias exists', () => {
  const shim = '/Users/test/.local/share/mise/shims/node'
  const resolver = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '/usr/bin:/bin' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([shim])
  })
  assert.equal(resolver.resolve('javascript', 'node'), shim)
})

test('honors an absolute MISE_DATA_DIR and falls back to home for an unsafe relative value', () => {
  const customShim = '/Volumes/tools/mise/shims/node'
  const custom = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '', MISE_DATA_DIR: '/Volumes/tools/mise' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([customShim])
  })
  assert.equal(custom.resolve('javascript', 'node'), customShim)

  const defaultShim = '/Users/test/.local/share/mise/shims/node'
  const relative = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '', MISE_DATA_DIR: '../untrusted' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([defaultShim])
  })
  assert.equal(relative.resolve('javascript', 'node'), defaultShim)
})

test('honors XDG_DATA_HOME after MISE_DATA_DIR and ignores relative XDG values', () => {
  const xdgShim = '/Volumes/tools/share/mise/shims/node'
  const xdg = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '', XDG_DATA_HOME: '/Volumes/tools/share' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([xdgShim])
  })
  assert.equal(xdg.resolve('javascript', 'node'), xdgShim)

  const miseShim = '/Volumes/mise/shims/node'
  const explicit = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '', MISE_DATA_DIR: '/Volumes/mise', XDG_DATA_HOME: '/Volumes/tools/share' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([miseShim, xdgShim])
  })
  assert.equal(explicit.resolve('javascript', 'node'), miseShim)

  const defaultShim = '/Users/test/.local/share/mise/shims/node'
  const relative = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '', XDG_DATA_HOME: '../share' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([defaultShim])
  })
  assert.equal(relative.resolve('javascript', 'node'), defaultShim)
})

test('rejects an installed mise alias that resolves outside the Node installation tree', () => {
  const alias = '/Users/test/.local/share/mise/installs/node/latest/bin/node'
  const escaped = '/tmp/untrusted-node'
  const resolver = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: '' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([alias, escaped], [], { [alias]: escaped })
  })
  assert.equal(resolver.resolve('javascript', 'node'), null)
})

test('does not apply the mise Node fallback to other platforms, languages, or command names', () => {
  const shim = '/Users/test/.local/share/mise/shims/node'
  const options = {
    environment: { PATH: '' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem([shim])
  }
  assert.equal(createInterpreterResolver({ ...options, platform: 'linux' }).resolve('javascript', 'node'), null)
  assert.equal(createInterpreterResolver({ ...options, platform: 'darwin' }).resolve('python', 'node'), null)
  assert.equal(createInterpreterResolver({ ...options, platform: 'darwin' }).resolve('javascript', 'nodejs'), null)
  assert.equal(createInterpreterResolver({ ...options, platform: 'darwin' }).resolve('javascript', 'Node'), null)
})

test('rejects missing, non-executable, and relative path-like interpreter values', () => {
  const blockedShim = '/Users/test/.local/share/mise/shims/node'
  const resolver = createInterpreterResolver({
    platform: 'darwin',
    environment: { PATH: ':/tools::' },
    homeDirectory: '/Users/test',
    fileSystem: createFileSystem(['/current/node'], [blockedShim, '/tools/node'])
  })
  assert.equal(resolver.resolve('javascript', ''), null)
  assert.equal(resolver.resolve('javascript', './node'), null)
  assert.equal(resolver.resolve('javascript', '../node'), null)
  assert.equal(resolver.resolve('javascript', 'folder/node'), null)
  assert.equal(resolver.resolve('javascript', 'node'), null)
})

test('uses Windows PATH and PATHEXT semantics without depending on the host platform', () => {
  const executable = 'C:\\Tools\\node.EXE'
  const resolver = createInterpreterResolver({
    platform: 'win32',
    environment: { Path: 'C:\\Missing;C:\\Tools', PATHEXT: '.CMD;.COM;.EXE' },
    homeDirectory: 'C:\\Users\\test',
    fileSystem: createFileSystem(['C:\\Tools\\node.CMD', executable])
  })
  assert.equal(resolver.resolve('javascript', 'node'), executable)
})

test('rejects Windows shell scripts because task execution keeps shell disabled', () => {
  const commandScript = 'C:\\Tools\\node.CMD'
  const resolver = createInterpreterResolver({
    platform: 'win32',
    environment: { PATH: 'C:\\Tools', PATHEXT: '.CMD;.BAT' },
    homeDirectory: 'C:\\Users\\test',
    fileSystem: createFileSystem([commandScript, 'C:\\Tools\\node.BAT'])
  })
  assert.equal(resolver.resolve('javascript', 'node'), null)
  assert.equal(resolver.resolve('javascript', commandScript), null)
})
