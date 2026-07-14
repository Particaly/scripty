import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import yauzl from 'yauzl'
import yazl from 'yazl'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RELEASE_ROOT = path.join(ROOT, 'release')
export const ZIP_ENTRY_DATE = new Date('1980-01-01T00:00:00.000Z')

/** Reads and parses one UTF-8 JSON file, surfacing malformed release inputs as build failures. */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/** Returns the lowercase SHA-256 digest for one buffer or file path. */
export function sha256(input) {
  const bytes = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** Converts a platform path to the canonical POSIX path used by release manifests and ZIP entries. */
export function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

/** Rejects unsafe or colliding release paths before they can enter a directory or archive. */
export function validateReleasePaths(paths) {
  const seen = new Set()
  for (const entryPath of paths) {
    const segments = typeof entryPath === 'string' ? entryPath.split('/') : []
    if (
      !entryPath || path.posix.isAbsolute(entryPath) || entryPath.includes('\\') || entryPath.includes('\0') ||
      segments.some(segment => !segment || segment === '.' || segment === '..')
    ) throw new Error(`Unsafe release path: ${entryPath}`)
    const key = entryPath.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate release path: ${entryPath}`)
    seen.add(key)
  }
}

/** Recursively lists ordinary files in stable path order and refuses symbolic links or special files. */
export function listFiles(directory) {
  const files = []
  /** Walks one directory while retaining paths relative to the requested release root. */
  function walk(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Release cannot contain symbolic links: ${childRelative}`)
      if (entry.isDirectory()) walk(child, childRelative)
      else if (entry.isFile()) files.push(toPosix(childRelative))
      else throw new Error(`Release cannot contain special files: ${childRelative}`)
    }
  }
  walk(directory)
  validateReleasePaths(files)
  return files.sort()
}

/** Produces the runtime manifest from the development manifest without editor-only or Vite-only fields. */
export function createProductionManifest(source, packageVersion) {
  const { $schema, development, ...manifest } = source
  if (manifest.version !== packageVersion) throw new Error('Package and plugin versions differ')
  return manifest
}

/** Copies one renderer file into staging while creating only its controlled parent directories. */
function copyRendererFile(distDirectory, stagingDirectory, relativePath) {
  const source = path.join(distDirectory, relativePath)
  const target = path.join(stagingDirectory, relativePath)
  if (!fs.statSync(source).isFile()) throw new Error(`Missing renderer output: ${relativePath}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

/** Bundles preload and all package dependencies into one CommonJS file, leaving only Node built-ins external. */
async function bundlePreload(stagingDirectory, productionManifest) {
  const output = path.join(stagingDirectory, 'preload/services.js')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['public/preload/services.js'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    packages: 'bundle',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    plugins: [{
      name: 'production-manifest',
      /** Redirects preload's adjacent manifest import to a path-stable virtual production manifest. */
      setup(buildContext) {
        buildContext.onResolve({ filter: /^\.\.\/plugin\.json$/ }, () => ({ path: 'plugin.json', namespace: 'production-manifest' }))
        buildContext.onLoad({ filter: /^plugin\.json$/, namespace: 'production-manifest' }, () => ({
          contents: fs.readFileSync(productionManifest, 'utf8'),
          loader: 'json'
        }))
      }
    }],
    metafile: true,
    logLevel: 'silent'
  })
  const invalidExternal = Object.keys(result.metafile.inputs).filter(input => !input.startsWith('node_modules/') && !input.startsWith('public/') && input !== 'production-manifest:plugin.json')
  if (invalidExternal.length) throw new Error(`Unexpected preload inputs: ${invalidExternal.join(', ')}`)
  const bundle = fs.readFileSync(output, 'utf8')
  if (/require\(["'](?:cron-parser|luxon|yauzl|yazl|pend|buffer-crc32)["']\)/.test(bundle)) {
    throw new Error('Preload bundle retains a third-party runtime require')
  }
  if (bundle.includes(ROOT)) throw new Error('Preload bundle contains the repository path')
}

/** Creates a self-contained plugin directory from Vite output, a production manifest, and bundled preload. */
export async function buildReleaseDirectory(targetDirectory) {
  const packageJson = readJson(path.join(ROOT, 'package.json'))
  const sourceManifest = readJson(path.join(ROOT, 'public/plugin.json'))
  const manifest = createProductionManifest(sourceManifest, packageJson.version)
  const distDirectory = path.join(ROOT, 'dist')
  fs.rmSync(targetDirectory, { recursive: true, force: true })
  fs.mkdirSync(targetDirectory, { recursive: true })
  copyRendererFile(distDirectory, targetDirectory, 'index.html')
  copyRendererFile(distDirectory, targetDirectory, 'logo.png')
  for (const file of listFiles(path.join(distDirectory, 'assets'))) copyRendererFile(distDirectory, targetDirectory, `assets/${file}`)
  const manifestPath = path.join(targetDirectory, 'plugin.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.mkdirSync(path.join(targetDirectory, 'preload'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'public/preload/package.json'), path.join(targetDirectory, 'preload/package.json'))
  await bundlePreload(targetDirectory, manifestPath)
  return { packageJson, manifest }
}

/** Writes sorted release files to a deterministic ordinary ZIP with fixed timestamps and permissions. */
export async function writeReleaseZip(directory, targetPath) {
  const files = listFiles(directory)
  const temporaryPath = `${targetPath}.tmp`
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.rmSync(temporaryPath, { force: true })
  const zipFile = new yazl.ZipFile()
  const output = fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
  try {
    const completed = pipeline(zipFile.outputStream, output)
    for (const entryPath of files) {
      zipFile.addBuffer(fs.readFileSync(path.join(directory, ...entryPath.split('/'))), entryPath, {
        mtime: ZIP_ENTRY_DATE,
        mode: 0o644,
        compress: true
      })
    }
    zipFile.end({ forceZip64Format: false })
    await completed
    fs.renameSync(temporaryPath, targetPath)
    return { files, sha256: sha256(targetPath) }
  } catch (error) {
    output.destroy()
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

/** Reads every ordinary ZIP entry into memory for bounded release verification and rejects duplicate paths. */
export function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) return reject(openError)
      const entries = new Map()
      const names = []
      zipFile.once('error', reject)
      zipFile.once('end', () => {
        try { validateReleasePaths(names); resolve(entries) } catch (error) { reject(error) }
      })
      zipFile.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zipFile.readEntry()
        names.push(entry.fileName)
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError)
          const chunks = []
          stream.on('data', chunk => chunks.push(chunk))
          stream.once('error', reject)
          stream.once('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zipFile.readEntry() })
        })
      })
      zipFile.readEntry()
    })
  })
}

/** Returns stable per-file hashes for comparing release directories across clean builds. */
export function hashDirectory(directory) {
  return Object.fromEntries(listFiles(directory).map(file => [file, sha256(path.join(directory, ...file.split('/')))]))
}
