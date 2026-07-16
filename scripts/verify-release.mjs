import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashDirectory, listFiles, readJson, readZipEntries, RELEASE_ROOT, ROOT, sha256 } from './release-lib.mjs'

const REQUIRED_FILES = ['index.html', 'logo.png', 'plugin.json', 'preload/package.json', 'preload/services.js']
const ALLOWED_PREFIXES = ['assets/']
const FORBIDDEN_TEXT = ['localhost:5173', ROOT, '/Users/Apple/', 'C:\\Users\\']

/** Resolves the versioned release paths from the root package metadata. */
export function getReleasePaths() {
  const packageJson = readJson(path.join(ROOT, 'package.json'))
  const artifactName = `${packageJson.name}-${packageJson.version}`
  return {
    packageJson,
    artifactName,
    directory: path.join(RELEASE_ROOT, artifactName),
    zipPath: path.join(RELEASE_ROOT, `${artifactName}.zip`)
  }
}

/** Ensures one production manifest is self-contained, version-aligned, and free of development metadata. */
export function verifyManifest(manifest, packageJson, files) {
  if ('$schema' in manifest || 'development' in manifest) throw new Error('Production manifest contains development metadata')
  if (manifest.version !== packageJson.version) throw new Error('Production manifest version differs from package version')
  for (const field of ['main', 'preload', 'logo']) {
    if (typeof manifest[field] !== 'string' || !files.includes(manifest[field])) throw new Error(`Missing manifest ${field} target`)
  }
  const codes = manifest.features?.map(feature => feature.code) ?? []
  if (!codes.length || new Set(codes).size !== codes.length || codes.some(code => typeof code !== 'string' || !code)) {
    throw new Error('Production manifest feature codes are missing or duplicated')
  }
  for (const feature of manifest.features) {
    if (!files.includes(feature.icon)) throw new Error(`Missing feature icon for ${feature.code}`)
    if (!Array.isArray(feature.cmds) || feature.cmds.some(command => typeof command !== 'string' || !command.trim())) {
      throw new Error(`Invalid feature commands for ${feature.code}`)
    }
  }
}

/** Verifies the canonical release directory whitelist, local HTML resources, and bundled preload closure. */
export function verifyReleaseDirectory(directory, packageJson) {
  const files = listFiles(directory)
  for (const required of REQUIRED_FILES) if (!files.includes(required)) throw new Error(`Missing required release file: ${required}`)
  for (const file of files) {
    const allowed = REQUIRED_FILES.includes(file) || ALLOWED_PREFIXES.some(prefix => file.startsWith(prefix))
    if (!allowed || file.endsWith('.map') || file.includes('node_modules/')) throw new Error(`Unexpected release file: ${file}`)
  }
  const manifest = readJson(path.join(directory, 'plugin.json'))
  verifyManifest(manifest, packageJson, files)
  const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8')
  const resources = [...html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(match => match[1])
  for (const resource of resources) if (!files.includes(resource)) throw new Error(`Missing HTML resource: ${resource}`)
  const textFiles = files.filter(file => /\.(?:html|json|js|css)$/.test(file))
  for (const file of textFiles) {
    const content = fs.readFileSync(path.join(directory, ...file.split('/')), 'utf8')
    for (const forbidden of FORBIDDEN_TEXT) if (content.includes(forbidden)) throw new Error(`Release text leaks forbidden value in ${file}`)
  }
  const preload = fs.readFileSync(path.join(directory, 'preload/services.js'), 'utf8')
  if (/require\(["'](?:cron-parser|luxon|yauzl|yazl|pend|buffer-crc32|\.\/app-service)["']\)/.test(preload)) {
    throw new Error('Preload bundle retains a runtime package or source-module require')
  }
  return { files, manifest, hashes: hashDirectory(directory) }
}

/** Compares the deterministic ZIP entry set and bytes with the canonical release directory. */
export async function verifyReleaseZip(directory, zipPath, files) {
  const entries = await readZipEntries(zipPath)
  const entryNames = [...entries.keys()]
  if (JSON.stringify(entryNames) !== JSON.stringify(files)) throw new Error('ZIP entry order or set differs from release directory')
  for (const file of files) {
    const source = fs.readFileSync(path.join(directory, ...file.split('/')))
    if (!source.equals(entries.get(file))) throw new Error(`ZIP entry differs from directory: ${file}`)
  }
  return sha256(zipPath)
}

/** Verifies the currently generated release directory and ZIP manifest. */
export async function verifyCurrentRelease() {
  const paths = getReleasePaths()
  const directoryResult = verifyReleaseDirectory(paths.directory, paths.packageJson)
  const zipSha256 = await verifyReleaseZip(paths.directory, paths.zipPath, directoryResult.files)
  return { ...paths, ...directoryResult, zipSha256 }
}

/** Runs release verification as a CLI while preserving exports for clean-copy verification. */
async function main() {
  const result = await verifyCurrentRelease()
  console.log(JSON.stringify({ directory: result.directory, zipPath: result.zipPath, zipSha256: result.zipSha256, files: result.files.length }, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main()
