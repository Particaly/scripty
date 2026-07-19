import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DIST_ROOT = path.join(ROOT, 'dist')

/** Reads and parses one UTF-8 JSON file, surfacing malformed build inputs as failures. */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/** Returns the lowercase SHA-256 digest for one buffer or file path. */
export function sha256(input) {
  const bytes = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** Converts a platform path to the canonical POSIX path used by build manifests. */
export function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

/** Rejects unsafe or colliding paths before they can enter the installable build directory. */
export function validateBuildPaths(paths) {
  const seen = new Set()
  for (const entryPath of paths) {
    const segments = typeof entryPath === 'string' ? entryPath.split('/') : []
    if (
      !entryPath || path.posix.isAbsolute(entryPath) || entryPath.includes('\\') || entryPath.includes('\0') ||
      segments.some(segment => !segment || segment === '.' || segment === '..')
    ) throw new Error(`Unsafe build path: ${entryPath}`)
    const key = entryPath.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate build path: ${entryPath}`)
    seen.add(key)
  }
}

/** Recursively lists ordinary files in stable path order and refuses symbolic links or special files. */
export function listFiles(directory) {
  const files = []
  /** Walks one directory while retaining paths relative to the requested build root. */
  function walk(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Build cannot contain symbolic links: ${childRelative}`)
      if (entry.isDirectory()) walk(child, childRelative)
      else if (entry.isFile()) files.push(toPosix(childRelative))
      else throw new Error(`Build cannot contain special files: ${childRelative}`)
    }
  }
  walk(directory)
  validateBuildPaths(files)
  return files.sort()
}

/** Produces the runtime manifest from the development manifest without editor-only or Vite-only fields. */
export function createProductionManifest(source, packageVersion) {
  const { $schema, development, ...manifest } = source
  if (manifest.version !== packageVersion) throw new Error('Package and plugin versions differ')
  return manifest
}

/** Copies one renderer file into staging while creating only its controlled parent directories. */
function copyRendererFile(rendererDirectory, stagingDirectory, relativePath) {
  const source = path.join(rendererDirectory, relativePath)
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

/** Replaces Vite's intermediate output with installable dist and removes partial output if finalization fails. */
export async function finalizeDistDirectory() {
  if (!fs.existsSync(DIST_ROOT)) throw new Error('Missing Vite output directory: dist')
  const packageJson = readJson(path.join(ROOT, 'package.json'))
  const sourceManifest = readJson(path.join(ROOT, 'public/plugin.json'))
  const manifest = createProductionManifest(sourceManifest, packageJson.version)
  const stagingDirectory = `${DIST_ROOT}.staging`
  fs.rmSync(stagingDirectory, { recursive: true, force: true })
  fs.mkdirSync(stagingDirectory, { recursive: true })
  try {
    copyRendererFile(DIST_ROOT, stagingDirectory, 'index.html')
    copyRendererFile(DIST_ROOT, stagingDirectory, 'logo.png')
    for (const file of listFiles(path.join(DIST_ROOT, 'assets'))) copyRendererFile(DIST_ROOT, stagingDirectory, `assets/${file}`)
    const manifestPath = path.join(stagingDirectory, 'plugin.json')
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.mkdirSync(path.join(stagingDirectory, 'preload'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'public/preload/package.json'), path.join(stagingDirectory, 'preload/package.json'))
    await bundlePreload(stagingDirectory, manifestPath)
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true })
    fs.rmSync(DIST_ROOT, { recursive: true, force: true })
    throw error
  }
  fs.rmSync(DIST_ROOT, { recursive: true, force: true })
  fs.renameSync(stagingDirectory, DIST_ROOT)
  return { packageJson, manifest }
}

/** Returns stable per-file hashes for comparing installable build directories across clean builds. */
export function hashDirectory(directory) {
  return Object.fromEntries(listFiles(directory).map(file => [file, sha256(path.join(directory, ...file.split('/')))]))
}
