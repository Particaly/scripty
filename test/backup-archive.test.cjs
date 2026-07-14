'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const yauzl = require('yauzl')
const { validateArchiveFiles, writeBackupArchive } = require('../public/preload/backup-archive')

/** Reads every non-directory ZIP entry into a path-to-buffer map without extracting to disk. */
function readZipEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) return reject(openError)
      const entries = new Map()
      zipFile.once('error', reject)
      zipFile.once('end', () => resolve(entries))
      zipFile.on('entry', (entry) => {
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError)
          const chunks = []
          stream.on('data', chunk => chunks.push(chunk))
          stream.once('error', reject)
          stream.once('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zipFile.readEntry()
          })
        })
      })
      zipFile.readEntry()
    })
  })
}

/** Creates a disposable absolute output path for archive writer tests. */
function createOutputPath(name = 'Scripty 中文 backup.zip') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-archive-'))
  return { directory, filePath: path.join(directory, name) }
}

test('writes an atomic ZIP whose entries preserve controlled paths and Unicode bytes', async (t) => {
  const output = createOutputPath()
  t.after(() => fs.rmSync(output.directory, { recursive: true, force: true }))
  const files = [
    { path: 'manifest.json', content: Buffer.from('{"formatVersion":"1.0"}\n') },
    { path: 'data/environments.json', content: Buffer.from('{"value":"中文 value !@#"}\n') },
    { path: 'scripts/123e4567-e89b-42d3-a456-426614174020.js', content: Buffer.from('console.log("中文")\n') }
  ]
  const size = await writeBackupArchive(files, output.filePath)
  const bytes = fs.readFileSync(output.filePath)
  assert.equal(size, bytes.length)
  assert.equal(bytes.subarray(0, 2).toString('binary'), 'PK')
  if (process.platform !== 'win32') assert.equal(fs.statSync(output.filePath).mode & 0o777, 0o600)
  const entries = await readZipEntries(output.filePath)
  assert.deepEqual([...entries.keys()], files.map(file => file.path))
  for (const file of files) assert.deepEqual(entries.get(file.path), file.content)
  assert.deepEqual(fs.readdirSync(output.directory), [path.basename(output.filePath)])
})

test('rejects traversal, absolute, backslash, duplicate, and non-buffer archive entries', async () => {
  const invalidSets = [
    [{ path: '../escape', content: Buffer.alloc(0) }],
    [{ path: '/absolute', content: Buffer.alloc(0) }],
    [{ path: 'data\\file', content: Buffer.alloc(0) }],
    [{ path: 'data/./file', content: Buffer.alloc(0) }],
    [{ path: 'data/file', content: 'text' }],
    [{ path: 'Data/file', content: Buffer.alloc(0) }, { path: 'data/file', content: Buffer.alloc(0) }]
  ]
  for (const files of invalidSets) {
    assert.throws(() => validateArchiveFiles(files), error => error.code === 'VALIDATION_ERROR')
  }
})

test('maps writer failures without exposing the destination and removes temporary output', async (t) => {
  const output = createOutputPath('private destination.zip')
  t.after(() => fs.rmSync(output.directory, { recursive: true, force: true }))
  const failures = [
    ['EACCES', 'PERMISSION_DENIED'],
    ['ENOSPC', 'DISK_FULL'],
    ['EIO', 'WRITE_FAILED']
  ]
  for (const [systemCode, expectedCode] of failures) {
    const createZipFile = () => ({
      outputStream: new (require('node:stream').PassThrough)(),
      addBuffer() {},
      end() {
        const error = new Error(output.filePath)
        error.code = systemCode
        this.outputStream.destroy(error)
      }
    })
    await assert.rejects(
      writeBackupArchive([{ path: 'manifest.json', content: Buffer.from('{}') }], output.filePath, { createZipFile }),
      error => error.code === expectedCode && !error.message.includes(output.filePath)
    )
    assert.equal(fs.existsSync(output.filePath), false)
    assert.deepEqual(fs.readdirSync(output.directory), [])
  }
})
