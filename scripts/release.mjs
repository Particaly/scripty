import fs from 'node:fs'
import path from 'node:path'
import { buildReleaseDirectory, hashDirectory, RELEASE_ROOT, ROOT, sha256, writeReleaseZip } from './release-lib.mjs'

/** Builds the canonical plugin directory and deterministic transport ZIP, then records their stable checksums. */
async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const artifactName = `${packageJson.name}-${packageJson.version}`
  const directory = path.join(RELEASE_ROOT, artifactName)
  const zipPath = path.join(RELEASE_ROOT, `${artifactName}.zip`)
  fs.rmSync(RELEASE_ROOT, { recursive: true, force: true })
  fs.mkdirSync(RELEASE_ROOT, { recursive: true })
  await buildReleaseDirectory(directory)
  const archive = await writeReleaseZip(directory, zipPath)
  const hashes = hashDirectory(directory)
  const lines = [
    `${archive.sha256}  ${path.basename(zipPath)}`,
    ...Object.entries(hashes).map(([file, digest]) => `${digest}  ${artifactName}/${file}`)
  ]
  fs.writeFileSync(path.join(RELEASE_ROOT, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  console.log(JSON.stringify({ directory, zipPath, zipSha256: sha256(zipPath), files: archive.files.length }, null, 2))
}

await main()
