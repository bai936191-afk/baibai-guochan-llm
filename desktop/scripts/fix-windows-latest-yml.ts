import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const outputDir = path.resolve(process.argv[2] ?? 'build-artifacts/electron')
const latestPath = path.join(outputDir, 'latest.yml')

if (!fs.existsSync(latestPath)) {
  process.exit(0)
}

const installers = fs.readdirSync(outputDir)
  .filter((name) => name.toLowerCase().endsWith('.exe'))
  .filter((name) => !name.includes('__uninstaller'))
  .map((name) => {
    const fullPath = path.join(outputDir, name)
    return { name, fullPath, stat: fs.statSync(fullPath) }
  })
  .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)

const installer = installers[0]
if (!installer) {
  throw new Error(`[fix-windows-latest-yml] No .exe installer found in ${outputDir}`)
}

const sha512 = crypto.createHash('sha512')
  .update(fs.readFileSync(installer.fullPath))
  .digest('base64')
const size = String(installer.stat.size)

const next = fs.readFileSync(latestPath, 'utf8')
  .replace(/^(\s*-\s*url:\s*).+$/m, `$1${installer.name}`)
  .replace(/^(\s*path:\s*).+$/m, `$1${installer.name}`)
  .replace(/^(\s*sha512:\s*).+$/gm, `$1${sha512}`)
  .replace(/^(\s*size:\s*).+$/m, `$1${size}`)

fs.writeFileSync(latestPath, next, 'utf8')
console.log(`[fix-windows-latest-yml] latest.yml -> ${installer.name}`)
