import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

type Platform = 'windows' | 'macos' | 'linux'

const outputDir = path.resolve(process.argv[2] ?? 'build-artifacts/electron')
const platform = parsePlatform(process.argv[3])

function parsePlatform(value: string | undefined): Platform | 'all' {
  if (!value || value === 'all') return 'all'
  if (value === 'windows' || value === 'macos' || value === 'linux') return value
  throw new Error(`[fix-update-metadata] Unsupported platform: ${value}`)
}

function fileRecord(filePath: string) {
  const stat = fs.statSync(filePath)
  return {
    name: path.basename(filePath),
    fullPath: filePath,
    stat,
    sha512: crypto.createHash('sha512')
      .update(fs.readFileSync(filePath))
      .digest('base64'),
  }
}

function newestMatching(predicate: (name: string) => boolean) {
  if (!fs.existsSync(outputDir)) return undefined
  return fs.readdirSync(outputDir)
    .filter(predicate)
    .map(name => fileRecord(path.join(outputDir, name)))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0]
}

function writeSingleArtifactMetadata(metadataName: string, artifact: ReturnType<typeof fileRecord> | undefined) {
  const metadataPath = path.join(outputDir, metadataName)
  if (!fs.existsSync(metadataPath)) return
  if (!artifact) {
    throw new Error(`[fix-update-metadata] No artifact found for ${metadataName} in ${outputDir}`)
  }

  const next = fs.readFileSync(metadataPath, 'utf8')
    .replace(/^(\s*-\s*url:\s*).+$/m, `$1${artifact.name}`)
    .replace(/^(\s*path:\s*).+$/m, `$1${artifact.name}`)
    .replace(/^(\s*sha512:\s*).+$/gm, `$1${artifact.sha512}`)
    .replace(/^(\s*size:\s*).+$/m, `$1${artifact.stat.size}`)

  fs.writeFileSync(metadataPath, next, 'utf8')
  console.log(`[fix-update-metadata] ${metadataName} -> ${artifact.name}`)
}

function fixWindows() {
  writeSingleArtifactMetadata(
    'latest.yml',
    newestMatching(name => name.toLowerCase().endsWith('.exe') && !name.includes('__uninstaller')),
  )
}

function fixMacos() {
  const metadataName = 'latest-mac.yml'
  const metadataPath = path.join(outputDir, metadataName)
  if (!fs.existsSync(metadataPath)) return

  const archives = fs.readdirSync(outputDir)
    .filter(name => name.endsWith('.zip') || name.endsWith('.dmg'))
    .map(name => fileRecord(path.join(outputDir, name)))
    .sort((left, right) => {
      if (left.name.endsWith('.zip') !== right.name.endsWith('.zip')) {
        return left.name.endsWith('.zip') ? -1 : 1
      }
      return right.stat.mtimeMs - left.stat.mtimeMs
    })

  const primary = archives[0]
  if (!primary) {
    throw new Error(`[fix-update-metadata] No macOS archive found in ${outputDir}`)
  }

  const filesBlock = archives
    .map(artifact => [
      `  - url: ${artifact.name}`,
      `    sha512: ${artifact.sha512}`,
      `    size: ${artifact.stat.size}`,
    ].join('\n'))
    .join('\n')

  const current = fs.readFileSync(metadataPath, 'utf8')
  const version = current.match(/^version:\s*(.+)$/m)?.[1] ?? '0.0.0'
  const releaseDate = current.match(/^releaseDate:\s*(.+)$/m)?.[1] ?? `'${new Date().toISOString()}'`
  const next = [
    `version: ${version}`,
    'files:',
    filesBlock,
    `path: ${primary.name}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: ${releaseDate}`,
    '',
  ].join('\n')

  fs.writeFileSync(metadataPath, next, 'utf8')
  console.log(`[fix-update-metadata] ${metadataName} -> ${archives.map(artifact => artifact.name).join(', ')}`)
}

function fixLinux() {
  const metadataNames = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir).filter(name => /^latest-linux(?:-[a-z0-9]+)?\.yml$/.test(name))
    : []
  for (const metadataName of metadataNames) {
    writeSingleArtifactMetadata(
      metadataName,
      newestMatching(name => name.endsWith('.AppImage')),
    )
  }
}

if (platform === 'all' || platform === 'windows') fixWindows()
if (platform === 'all' || platform === 'macos') fixMacos()
if (platform === 'all' || platform === 'linux') fixLinux()
