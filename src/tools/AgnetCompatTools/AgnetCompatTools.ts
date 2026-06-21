import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type Tool, type ToolResult } from '../../Tool.js'
import type { ToolProgressData } from '../../types/tools.js'
import type { PermissionResult } from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'

const TEXT_FILE_EXTENSIONS = new Set([
  '.bat', '.c', '.cc', '.cfg', '.cmd', '.conf', '.cpp', '.cs', '.css', '.csv',
  '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt',
  '.less', '.lua', '.md', '.mjs', '.php', '.ps1', '.py', '.rb', '.rs', '.scss',
  '.sh', '.sql', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml',
  '.yaml', '.yml',
])

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '.next',
  '.cache',
  '.go-cache',
  '.gocache',
])

type TextOutput = string
type ShellProgressType = 'bash_progress' | 'powershell_progress'

type AgnetShellProgress = ToolProgressData & {
  type: ShellProgressType
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  timeoutMs: number
  taskId: string
}

let runCommandProgressCounter = 0

const RUN_COMMAND_PROGRESS_MAX_CHARS = 120_000

function output(content: string, toolUseID: string) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result' as const,
    content,
  }
}

function baseTool<
  Input extends z.ZodType<{ [key: string]: unknown }>,
  P extends ToolProgressData = ToolProgressData,
>(
  def: Omit<ToolDef<Input, TextOutput, P>, 'maxResultSizeChars' | 'mapToolResultToToolResultBlockParam' | 'renderToolUseMessage' | 'renderToolResultMessage'> & {
    readonly maxResultSizeChars?: number
  },
): Tool<Input, TextOutput, P> {
  return buildTool({
    maxResultSizeChars: 100_000,
    mapToolResultToToolResultBlockParam: output,
    renderToolUseMessage(input) {
      const summary = Object.entries(input ?? {})
        .filter(([, value]) => value !== undefined && value !== '')
        .slice(0, 2)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(', ')
      return summary ? `${def.name} ${summary}` : def.name
    },
    renderToolResultMessage(content) {
      return content
    },
    async checkPermissions(input): Promise<PermissionResult> {
      if (def.isReadOnly?.(input)) {
        return { behavior: 'allow', updatedInput: input }
      }

      return {
        behavior: 'passthrough',
        message: `${def.name} requires permission.`,
      }
    },
    ...def,
    async call(input, context, canUseTool, parentMessage, onProgress) {
      try {
        return await def.call(input, context, canUseTool, parentMessage, onProgress)
      } catch (error) {
        return softFailure(def.name, error)
      }
    },
  }) as Tool<Input, TextOutput, P>
}

function stripPathQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

function normalizePathSegment(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

function hasNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value)
}

function segmentLooksLikeUnicodeCompletion(actual: string, requested: string): boolean {
  const actualNorm = normalizePathSegment(actual)
  const requestedNorm = normalizePathSegment(requested)
  if (!actualNorm || !requestedNorm) return false
  if (actualNorm === requestedNorm) return true
  if (actual.normalize('NFC') === requested.normalize('NFC')) return true
  if (requestedNorm.length < 2) return false
  return hasNonAscii(actual) && actualNorm.endsWith(requestedNorm)
}

async function findUniqueSibling(parent: string, requestedName: string): Promise<string | null> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.readdir(parent, { withFileTypes: true })
  } catch {
    return null
  }

  const matches = entries
    .map(entry => entry.name)
    .filter(name => segmentLooksLikeUnicodeCompletion(name, requestedName))

  if (matches.length !== 1) return null
  return path.join(parent, matches[0]!)
}

async function resolveExistingOrSimilarPath(target: string): Promise<string> {
  const normalized = path.normalize(target)
  if (await pathExists(normalized)) return normalized

  const parsed = path.parse(normalized)
  const root = parsed.root
  const remainder = normalized.slice(root.length)
  const segments = remainder.split(/[\\/]+/).filter(Boolean)
  if (!segments.length) return normalized

  let current = root || path.parse(getCwd()).root
  for (const segment of segments) {
    const direct = path.join(current, segment)
    if (await pathExists(direct)) {
      current = direct
      continue
    }

    const sibling = await findUniqueSibling(current, segment)
    if (!sibling) return normalized
    current = sibling
  }

  return current
}

async function resolveWorkPath(
  value: string | undefined,
  options: { targetMayNotExist?: boolean } = {},
): Promise<string> {
  const p = stripPathQuotes(value ?? '')
  const raw = p || getCwd()
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(getCwd(), raw)
  if (await pathExists(target)) return target

  if (options.targetMayNotExist) {
    const parent = await resolveExistingOrSimilarPath(path.dirname(target))
    return path.join(parent, path.basename(target))
  }

  return resolveExistingOrSimilarPath(target)
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function pickRawString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function hasStringField(input: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some(key => typeof input[key] === 'string')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function buildLineEndingIndexMap(value: string): { normalized: string; map: number[] } {
  let normalized = ''
  const map: number[] = []

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\r') {
      normalized += '\n'
      map.push(index)
      if (value[index + 1] === '\n') index += 1
      continue
    }

    normalized += char
    map.push(index)
  }

  return { normalized, map }
}

function findLineEndingInsensitiveRanges(
  original: string,
  oldString: string,
): Array<{ start: number; end: number }> {
  const { normalized, map } = buildLineEndingIndexMap(original)
  const needle = normalizeLineEndings(oldString)
  if (!needle) return []

  const ranges: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= normalized.length) {
    const index = normalized.indexOf(needle, from)
    if (index === -1) break
    const normalizedEnd = index + needle.length
    ranges.push({
      start: map[index] ?? original.length,
      end: normalizedEnd >= normalized.length ? original.length : (map[normalizedEnd] ?? original.length),
    })
    from = index + Math.max(needle.length, 1)
  }
  return ranges
}

function findWhitespaceFlexibleRanges(
  original: string,
  oldString: string,
): Array<{ start: number; end: number }> {
  const normalizedOld = normalizeLineEndings(oldString)
  if (normalizedOld.trim().length < 8) return []
  const pattern = normalizedOld
    .split(/(\s+)/)
    .map(part => /\s+/.test(part) ? '\\s+' : escapeRegExp(part))
    .join('')
  if (!pattern) return []

  const regex = new RegExp(pattern, 'g')
  const ranges: Array<{ start: number; end: number }> = []
  for (const match of original.matchAll(regex)) {
    if (match.index === undefined) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function replaceRanges(
  original: string,
  ranges: Array<{ start: number; end: number }>,
  newString: string,
  replaceAll: boolean,
): { updated: string; replacements: number } | null {
  if (ranges.length === 0) return null
  if (ranges.length > 1 && !replaceAll) return null

  const selected = replaceAll ? ranges : ranges.slice(0, 1)
  let updated = original
  for (const range of [...selected].sort((a, b) => b.start - a.start)) {
    updated = `${updated.slice(0, range.start)}${newString}${updated.slice(range.end)}`
  }
  return { updated, replacements: selected.length }
}

function softFailure(toolName: string, error: unknown): ToolResult<TextOutput> {
  const message = error instanceof Error ? error.message : String(error)
  return {
    data: `${toolName} 未完成：${message}\n可以调整参数后重试。`,
  }
}

const pathKeys = [
  'path',
  'filePath',
  'file_path',
  'target_file',
  'targetFile',
  'file',
  'filename',
  'target',
]

const directoryKeys = [
  'path',
  'target_directory',
  'targetDirectory',
  'directory',
  'dir',
  'root',
  'cwd',
  'working_directory',
  'workingDirectory',
]

function pickPath(input: Record<string, unknown>): string {
  return pickString(input, ...pathKeys)
}

function pickDirectory(input: Record<string, unknown>): string {
  return pickString(input, ...directoryKeys)
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const numberLike = z.union([z.number(), z.string()])
const booleanLike = z.union([z.boolean(), z.string()])
const requestBodyLike = z.union([z.string(), z.record(z.string(), z.unknown())])

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  }
  return fallback
}

function countLines(text: string): number {
  if (!text) return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

function tailForProgress(text: string): string {
  if (text.length <= RUN_COMMAND_PROGRESS_MAX_CHARS) return text
  return text.slice(text.length - RUN_COMMAND_PROGRESS_MAX_CHARS)
}

function powerShellCommandWithUtf8(command: string): string {
  return [
    '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false',
    '$OutputEncoding = [Console]::OutputEncoding',
    command,
  ].join('; ')
}

function truncateLine(line: string, max = 2000): string {
  return line.length > max ? `${line.slice(0, max)}...` : line
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/')
}

function wildcardToRegex(pattern: string): RegExp {
  let p = normalizeSlash(pattern.trim())
  if (!p.startsWith('**/')) p = `**/${p}`
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

async function* walkFiles(root: string, maxFiles = 5000): AsyncGenerator<string> {
  let yielded = 0
  async function* walk(dir: string): AsyncGenerator<string> {
    if (yielded >= maxFiles) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (yielded >= maxFiles) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) yield* walk(full)
        continue
      }
      if (!entry.isFile()) continue
      yielded += 1
      yield full
    }
  }
  yield* walk(root)
}

async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return !buffer.subarray(0, bytesRead).includes(0)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

async function readTextFile(filePath: string, maxBytes = 1024 * 1024): Promise<string> {
  const stat = await fs.stat(filePath)
  if (stat.size > maxBytes) {
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return `${buffer.subarray(0, bytesRead).toString('utf8')}\n...[truncated at ${maxBytes} bytes]`
    } finally {
      await handle.close()
    }
  }
  return fs.readFile(filePath, 'utf8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url: string, init?: RequestInit, limit = 1024 * 1024): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(url, init)
  const buffer = Buffer.from(await response.arrayBuffer())
  const body = buffer.length > limit
    ? `${buffer.subarray(0, limit).toString('utf8')}\n...[truncated at ${limit} bytes]`
    : buffer.toString('utf8')
  return { status: response.status, headers: response.headers, body }
}

function dataDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha', 'agnet-data')
}

function todosPath(): string {
  return path.join(dataDir(), 'todos.json')
}

function notesDir(): string {
  return path.join(dataDir(), 'notes')
}

function noteNameFrom(input: Record<string, unknown>): string {
  return pickString(input, 'name', 'note', 'note_name', 'noteName', 'title')
}

function noteContentFrom(input: Record<string, unknown>): string {
  return pickRawString(input, 'content', 'text', 'body')
}

function requestUrlFrom(input: Record<string, unknown>): string {
  return pickString(input, 'url', 'uri', 'target_url', 'targetUrl')
}

function httpMethodFrom(input: Record<string, unknown>): string {
  return pickString(input, 'method', 'http_method', 'httpMethod') || 'GET'
}

function commandFrom(input: Record<string, unknown>): string {
  return pickString(input, 'command', 'cmd', 'shell_command', 'shellCommand')
}

function stringHeadersFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, headerValue]) => key.trim() && headerValue !== undefined && headerValue !== null)
      .map(([key, headerValue]) => [key, String(headerValue)]),
  )
}

function stringBodyFrom(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function assertNoteName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('name must match [A-Za-z0-9._-]+')
  }
}

const readFileSchema = z.object({
  path: z.string().optional().describe('Absolute path to the file'),
  filePath: z.string().optional().describe('Alias for path'),
  file_path: z.string().optional().describe('Alias for path'),
  target_file: z.string().optional().describe('Alias for path'),
  targetFile: z.string().optional().describe('Alias for path'),
  file: z.string().optional().describe('Alias for path'),
  filename: z.string().optional().describe('Alias for path'),
  target: z.string().optional().describe('Alias for path'),
  offset: numberLike.optional().describe('1-based line number to start reading from'),
  limit: numberLike.optional().describe('Maximum number of lines to return'),
})

const writeFileSchema = z.object({
  path: z.string().optional().describe('Absolute path to the file'),
  filePath: z.string().optional().describe('Alias for path'),
  file_path: z.string().optional().describe('Alias for path'),
  target_file: z.string().optional().describe('Alias for path'),
  targetFile: z.string().optional().describe('Alias for path'),
  file: z.string().optional().describe('Alias for path'),
  filename: z.string().optional().describe('Alias for path'),
  target: z.string().optional().describe('Alias for path'),
  content: z.string().optional().describe('File content'),
  contents: z.string().optional().describe('Alias for content'),
  text: z.string().optional().describe('Alias for content'),
})

const editFileSchema = z.object({
  path: z.string().optional().describe('Absolute path to the file'),
  filePath: z.string().optional().describe('Alias for path'),
  file_path: z.string().optional().describe('Alias for path'),
  target_file: z.string().optional().describe('Alias for path'),
  targetFile: z.string().optional().describe('Alias for path'),
  file: z.string().optional().describe('Alias for path'),
  filename: z.string().optional().describe('Alias for path'),
  target: z.string().optional().describe('Alias for path'),
  old_string: z.string().optional().describe('Exact text to find'),
  oldString: z.string().optional().describe('Alias for old_string'),
  old: z.string().optional().describe('Alias for old_string'),
  search: z.string().optional().describe('Alias for old_string'),
  new_string: z.string().optional().describe('Replacement text'),
  newString: z.string().optional().describe('Alias for new_string'),
  new: z.string().optional().describe('Alias for new_string'),
  replacement: z.string().optional().describe('Alias for new_string'),
  replace_all: booleanLike.optional().describe('Replace all occurrences'),
  replaceAll: booleanLike.optional().describe('Alias for replace_all'),
})

const listDirSchema = z.object({
  path: z.string().optional().describe('Absolute path to the directory'),
  target_directory: z.string().optional().describe('Alias for path'),
  targetDirectory: z.string().optional().describe('Alias for path'),
  directory: z.string().optional().describe('Alias for path'),
  dir: z.string().optional().describe('Alias for path'),
  root: z.string().optional().describe('Alias for path'),
  depth: numberLike.optional().describe('Max depth'),
})

const deleteFileSchema = z.object({
  path: z.string().optional().describe('Absolute path to the file to delete'),
  filePath: z.string().optional().describe('Alias for path'),
  file_path: z.string().optional().describe('Alias for path'),
  target_file: z.string().optional().describe('Alias for path'),
  targetFile: z.string().optional().describe('Alias for path'),
  file: z.string().optional().describe('Alias for path'),
  filename: z.string().optional().describe('Alias for path'),
  target: z.string().optional().describe('Alias for path'),
})

const grepSchema = z.object({
  pattern: z.string().optional().describe('Regular expression'),
  regex: z.string().optional().describe('Alias for pattern'),
  query: z.string().optional().describe('Alias for pattern'),
  path: z.string().optional().describe('File or directory'),
  filePath: z.string().optional().describe('Alias for path'),
  file_path: z.string().optional().describe('Alias for path'),
  target_file: z.string().optional().describe('Alias for path'),
  targetFile: z.string().optional().describe('Alias for path'),
  directory: z.string().optional().describe('Alias for path'),
  dir: z.string().optional().describe('Alias for path'),
  glob: z.string().optional().describe('Glob filter on filenames'),
  include: z.string().optional().describe('Alias for glob'),
  glob_pattern: z.string().optional().describe('Alias for glob'),
  globPattern: z.string().optional().describe('Alias for glob'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  case_insensitive: booleanLike.optional(),
  caseInsensitive: booleanLike.optional(),
  ignore_case: booleanLike.optional(),
  ignoreCase: booleanLike.optional(),
  '-i': booleanLike.optional(),
  case_sensitive: booleanLike.optional(),
  caseSensitive: booleanLike.optional(),
  multiline: booleanLike.optional(),
  head_limit: numberLike.optional(),
  headLimit: numberLike.optional(),
  max_results: numberLike.optional(),
  maxResults: numberLike.optional(),
})

const globSchema = z.object({
  pattern: z.string().optional().describe('Glob pattern'),
  glob_path: z.string().optional().describe('Alias for pattern'),
  globPath: z.string().optional().describe('Alias for pattern'),
  glob: z.string().optional().describe('Alias for pattern'),
  query: z.string().optional().describe('Alias for pattern'),
  file_pattern: z.string().optional().describe('Alias for pattern'),
  filePattern: z.string().optional().describe('Alias for pattern'),
  path: z.string().optional().describe('Root directory'),
  directory: z.string().optional().describe('Alias for path'),
  dir: z.string().optional().describe('Alias for path'),
  root: z.string().optional().describe('Alias for path'),
  head_limit: numberLike.optional(),
  headLimit: numberLike.optional(),
  max_results: numberLike.optional(),
  maxResults: numberLike.optional(),
})

const codebaseSearchSchema = z.object({
  query: z.string().optional().describe('Natural language query'),
  pattern: z.string().optional().describe('Alias for query'),
  text: z.string().optional().describe('Alias for query'),
  path: z.string().optional().describe('Root directory'),
  directory: z.string().optional().describe('Alias for path'),
  dir: z.string().optional().describe('Alias for path'),
  root: z.string().optional().describe('Alias for path'),
  max_results: numberLike.optional(),
  maxResults: numberLike.optional(),
  max_files: numberLike.optional(),
  maxFiles: numberLike.optional(),
})

const runCommandSchema = z.object({
  command: z.string().optional().describe('Shell command to execute'),
  cmd: z.string().optional().describe('Alias for command'),
  shell_command: z.string().optional().describe('Alias for command'),
  shellCommand: z.string().optional().describe('Alias for command'),
  working_directory: z.string().optional(),
  workingDirectory: z.string().optional(),
  cwd: z.string().optional(),
  workdir: z.string().optional(),
  timeout_sec: numberLike.optional(),
  timeoutSec: numberLike.optional(),
  timeout: numberLike.optional(),
})

const webFetchSchema = z.object({
  url: z.string().url().optional(),
  uri: z.string().url().optional(),
  target_url: z.string().url().optional(),
  targetUrl: z.string().url().optional(),
  prompt: z.string().optional(),
  timeout_sec: numberLike.optional(),
  timeoutSec: numberLike.optional(),
})

const webSearchSchema = z.object({
  query: z.string().optional(),
  q: z.string().optional(),
  max_results: numberLike.optional(),
  maxResults: numberLike.optional(),
  timeout_sec: numberLike.optional(),
  timeoutSec: numberLike.optional(),
})

const jinaReaderSchema = z.object({
  url: z.string().url().optional(),
  uri: z.string().url().optional(),
  target_url: z.string().url().optional(),
  targetUrl: z.string().url().optional(),
  timeout_sec: numberLike.optional(),
  timeoutSec: numberLike.optional(),
  repair_gbk: booleanLike.optional(),
  repairGbk: booleanLike.optional(),
})

const httpRequestSchema = z.object({
  method: z.string().optional(),
  url: z.string().url().optional(),
  uri: z.string().url().optional(),
  target_url: z.string().url().optional(),
  targetUrl: z.string().url().optional(),
  body: requestBodyLike.optional(),
  json: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  content_type: z.string().optional(),
  contentType: z.string().optional(),
  accept: z.string().optional(),
  auth_header: z.string().optional(),
  authHeader: z.string().optional(),
  timeout_sec: numberLike.optional(),
  timeoutSec: numberLike.optional(),
  follow_redirects: booleanLike.optional(),
  followRedirects: booleanLike.optional(),
})

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

const todoItemsSchema = z.array(todoItemSchema)

const todoWriteSchema = z.object({
  todos: z.union([todoItemsSchema, z.string()]).optional().describe('Array of {content, status} objects, or a JSON array string'),
  items: z.union([todoItemsSchema, z.string()]).optional().describe('Alias for todos'),
  tasks: z.union([todoItemsSchema, z.string()]).optional().describe('Alias for todos'),
  raw: z.union([todoItemsSchema, z.string()]).optional().describe('Alias for todos when a JSON array was supplied directly'),
})

function parseTodos(value: z.infer<typeof todoWriteSchema>['todos']): z.infer<typeof todoItemSchema>[] {
  if (value === undefined) throw new Error('todos must be an array or a JSON array string')
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    const maybeTodos = Array.isArray(parsed) ? parsed : parsed?.todos
    const result = todoItemsSchema.safeParse(maybeTodos)
    if (result.success) return result.data
  } catch {
    // Report a clean, tool-specific error below.
  }
  throw new Error('todos must be an array or a JSON array string')
}

const emptySchema = z.object({})

const noteNameSchema = z.object({
  name: z.string().optional(),
  note: z.string().optional(),
  note_name: z.string().optional(),
  noteName: z.string().optional(),
  title: z.string().optional(),
})

const notesWriteSchema = z.object({
  name: z.string().optional(),
  note: z.string().optional(),
  note_name: z.string().optional(),
  noteName: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  body: z.string().optional(),
})

const readFileTool = baseTool({
  name: 'read_file',
  searchHint: 'read a text file with numbered lines',
  inputSchema: readFileSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Read ${pickPath(input) || 'a file'}`
  },
  async prompt() {
    return 'Read a file. Returns content prefixed with line numbers (cat -n style). Lines longer than 2000 chars are truncated.'
  },
  async validateInput(input) {
    if (!pickPath(input)) return { result: false, message: 'path is required', errorCode: 1 }
    return { result: true }
  },
  async call(input) {
    const target = await resolveWorkPath(pickPath(input))
    const text = await readTextFile(target)
    const lines = text.split(/\r?\n/)
    const offset = Math.max(1, Math.floor(asNumber(input.offset, 1)))
    const limit = Math.max(1, Math.floor(asNumber(input.limit, 2000)))
    return {
      data: lines
        .slice(offset - 1, offset - 1 + limit)
        .map((line, index) => `${String(offset + index).padStart(6, ' ')}\t${truncateLine(line)}`)
        .join('\n'),
    }
  },
})

const writeFileTool = baseTool({
  name: 'write_file',
  searchHint: 'write or overwrite a file',
  inputSchema: writeFileSchema,
  isReadOnly: () => false,
  isDestructive: () => true,
  async description(input) {
    return `Write ${pickPath(input) || 'a file'}`
  },
  async prompt() {
    return 'Write content to a file, overwriting if it exists. Creates parent directories.'
  },
  async validateInput(input) {
    if (!pickPath(input)) return { result: false, message: 'path is required', errorCode: 1 }
    if (input.content === undefined && input.contents === undefined && input.text === undefined) {
      return { result: false, message: 'content is required', errorCode: 2 }
    }
    return { result: true }
  },
  async call(input) {
    const target = await resolveWorkPath(pickPath(input), { targetMayNotExist: true })
    const content = pickRawString(input, 'content', 'contents', 'text')
    const oldContent = await fs.readFile(target, 'utf8').catch(() => null)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    const byteLength = Buffer.byteLength(content, 'utf8')
    const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length
    return {
      data: oldContent === null
        ? `created ${target}; ${lineCount} line(s), ${byteLength} byte(s)`
        : `updated ${target}; ${lineCount} line(s), ${byteLength} byte(s)`,
    }
  },
})

const editFileTool = baseTool({
  name: 'edit_file',
  searchHint: 'replace exact text in a file',
  inputSchema: editFileSchema,
  isReadOnly: () => false,
  isDestructive: () => true,
  async description(input) {
    return `Edit ${pickPath(input) || 'a file'}`
  },
  async prompt() {
    return 'Replace text occurrences in a file. Tries exact matching first, then safe CRLF/LF and whitespace-tolerant matching. If no safe unique match is found, returns a non-destructive result instead of editing the file.'
  },
  async validateInput(input) {
    if (!pickPath(input)) return { result: false, message: 'path is required', errorCode: 1 }
    if (!hasStringField(input, 'old_string', 'oldString', 'old', 'search')) return { result: false, message: 'old_string is required', errorCode: 2 }
    return { result: true }
  },
  async call(input) {
    const target = await resolveWorkPath(pickPath(input))
    const oldString = pickRawString(input, 'old_string', 'oldString', 'old', 'search')
    const newString = pickRawString(input, 'new_string', 'newString', 'new', 'replacement')
    if (oldString === newString) return { data: 'old_string equals new_string; nothing to do' }
    const original = await fs.readFile(target, 'utf8')
    const count = original.split(oldString).length - 1
    const replaceAll = asBoolean(input.replace_all ?? input.replaceAll, false)

    if (count > 1 && !replaceAll) {
      return {
        data: `not modified ${target}; old_string matched ${count} times. Add more surrounding context or pass replace_all=true.`,
      }
    }

    let updated: string | null = null
    let replacements = 0
    let matchMode = 'exact'

    if (count > 0) {
      updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString)
      replacements = replaceAll ? count : 1
    } else {
      if (newString && original.includes(newString)) {
        return { data: `not modified ${target}; target already contains new_string` }
      }

      const lineEndingMatch = replaceRanges(
        original,
        findLineEndingInsensitiveRanges(original, oldString),
        newString,
        replaceAll,
      )
      if (lineEndingMatch) {
        updated = lineEndingMatch.updated
        replacements = lineEndingMatch.replacements
        matchMode = 'line-ending-insensitive'
      } else {
        const whitespaceMatch = replaceRanges(
          original,
          findWhitespaceFlexibleRanges(original, oldString),
          newString,
          replaceAll,
        )
        if (whitespaceMatch) {
          updated = whitespaceMatch.updated
          replacements = whitespaceMatch.replacements
          matchMode = 'whitespace-flexible'
        }
      }
    }

    if (updated === null) {
      const oldPreview = normalizeLineEndings(oldString).trim().split('\n').slice(0, 4).join('\n')
      return {
        data: `not modified ${target}; old_string not found. Read the current file and retry with fresh surrounding context.\n\nRequested old_string preview:\n${oldPreview}`,
      }
    }

    await fs.writeFile(target, updated, 'utf8')
    return { data: `updated ${target}; replacements: ${replacements}; match: ${matchMode}` }
  },
})

const listDirTool = baseTool({
  name: 'list_dir',
  searchHint: 'list directory contents',
  inputSchema: listDirSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `List ${pickDirectory(input) || getCwd()}`
  },
  async prompt() {
    return "List directory contents. Directories marked with 'd', files with ' '. Dot-entries are hidden. Set depth>1 for limited recursion."
  },
  async call(input) {
    const root = await resolveWorkPath(pickDirectory(input))
    const maxDepth = Math.max(1, Math.floor(asNumber(input.depth, 1)))
    const rows: string[] = []
    async function walk(dir: string, depth: number, prefix = ''): Promise<void> {
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter(entry => !entry.name.startsWith('.'))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const entry of entries) {
        const marker = entry.isDirectory() ? 'd' : ' '
        rows.push(`${marker} ${prefix}${entry.name}`)
        if (entry.isDirectory() && depth < maxDepth && !IGNORED_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name), depth + 1, `${prefix}${entry.name}/`)
        }
      }
    }
    await walk(root, 1)
    return { data: rows.join('\n') || '(empty)' }
  },
})

const deleteFileTool = baseTool({
  name: 'delete_file',
  searchHint: 'delete a file',
  inputSchema: deleteFileSchema,
  isReadOnly: () => false,
  isDestructive: () => true,
  async description(input) {
    return `Delete ${pickPath(input) || 'a file'}`
  },
  async prompt() {
    return 'Delete a file. Refuses to delete directories. Irreversible - use with caution.'
  },
  async validateInput(input) {
    if (!pickPath(input)) return { result: false, message: 'path is required', errorCode: 1 }
    return { result: true }
  },
  async call(input) {
    const target = await resolveWorkPath(pickPath(input))
    const stat = await fs.stat(target)
    if (stat.isDirectory()) throw new Error('path is a directory; delete_file only handles files')
    const previous = await readTextFile(target, 128 * 1024).catch(() => '')
    await fs.unlink(target)
    return { data: `deleted ${target}\n\nPrevious content preview:\n${previous}` }
  },
})

const grepTool = baseTool({
  name: 'grep',
  searchHint: 'search file contents with regex',
  inputSchema: grepSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Search for ${pickString(input, 'pattern', 'regex', 'query')}`
  },
  async prompt() {
    return 'Search file contents with regex. Returns matching lines as path:line:content by default. Use output_mode=files_with_matches for just paths, count for totals. Skips .git/node_modules/vendor/etc.'
  },
  async call(input) {
    const root = await resolveWorkPath(pickString(input, 'path', 'filePath', 'file_path', 'target_file', 'targetFile', 'directory', 'dir'))
    const caseInsensitive = asBoolean(
      input.case_insensitive ?? input.caseInsensitive ?? input.ignore_case ?? input.ignoreCase ?? input['-i'],
      asBoolean(input.case_sensitive ?? input.caseSensitive, true) === false,
    )
    const multiline = asBoolean(input.multiline, false)
    const pattern = pickString(input, 'pattern', 'regex', 'query')
    const regex = new RegExp(pattern, `${caseInsensitive ? 'i' : ''}${multiline ? 'm' : ''}`)
    const mode = input.output_mode ?? 'content'
    const headLimit = Math.max(1, Math.floor(asNumber(input.head_limit ?? input.headLimit ?? input.max_results ?? input.maxResults, 100)))
    const globPattern = pickString(input, 'glob', 'include', 'glob_pattern', 'globPattern')
    const fileGlob = globPattern ? wildcardToRegex(globPattern) : null
    const targets: string[] = []
    const stat = await fs.stat(root)
    if (stat.isFile()) targets.push(root)
    else for await (const file of walkFiles(root)) targets.push(file)
    let matches = 0
    const matchedFiles = new Set<string>()
    const rows: string[] = []
    for (const file of targets) {
      if (rows.length >= headLimit && mode !== 'count') break
      const relative = normalizeSlash(path.relative(root, file) || path.basename(file))
      if (fileGlob && !fileGlob.test(relative) && !fileGlob.test(path.basename(file))) continue
      if (!(await isTextFile(file))) continue
      const content = await readTextFile(file, 10 * 1024 * 1024).catch(() => '')
      const lines = multiline ? [content] : content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i] ?? '')) continue
        regex.lastIndex = 0
        matches += 1
        matchedFiles.add(file)
        if (mode === 'content' && rows.length < headLimit) {
          rows.push(`${file}:${multiline ? 1 : i + 1}:${truncateLine(lines[i] ?? '')}`)
        }
        if (mode === 'files_with_matches') break
      }
    }
    if (mode === 'count') return { data: `matches: ${matches}` }
    if (mode === 'files_with_matches') return { data: [...matchedFiles].slice(0, headLimit).join('\n') || '(no matches)' }
    return { data: rows.join('\n') || '(no matches)' }
  },
})

const globTool = baseTool({
  name: 'glob',
  aliases: ['glob_path'],
  searchHint: 'find files by glob pattern',
  inputSchema: globSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Glob ${pickString(input, 'pattern', 'glob_path', 'globPath', 'glob', 'query', 'file_pattern', 'filePattern')}`
  },
  async prompt() {
    return 'Find files matching a glob pattern. Supports ** for recursive matching (e.g. **/*.go, **/foo/bar.json). Pattern not starting with **/ is auto-prepended.'
  },
  async call(input) {
    const root = await resolveWorkPath(pickDirectory(input))
    const re = wildcardToRegex(pickString(input, 'pattern', 'glob_path', 'globPath', 'glob', 'query', 'file_pattern', 'filePattern'))
    const limit = Math.max(1, Math.floor(asNumber(input.head_limit ?? input.headLimit ?? input.max_results ?? input.maxResults, 100)))
    const results: string[] = []
    for await (const file of walkFiles(root)) {
      const relative = normalizeSlash(path.relative(root, file))
      if (re.test(relative)) results.push(file)
      if (results.length >= limit) break
    }
    return { data: results.join('\n') || '(no matches)' }
  },
})

const codebaseSearchTool = baseTool({
  name: 'codebase_search',
  searchHint: 'keyword search over code files',
  inputSchema: codebaseSearchSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Search codebase for ${pickString(input, 'query', 'pattern', 'text')}`
  },
  async prompt() {
    return 'Keyword-based code/docs search. Indexes text files in the directory, scores files by term frequency against the query, returns ranked results with snippets. Note: TF-based ranking, NOT embedding-based semantic search.'
  },
  async call(input) {
    const root = await resolveWorkPath(pickDirectory(input))
    const query = pickString(input, 'query', 'pattern', 'text')
    const terms = query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/i).filter(term => term.length > 1)
    if (!terms.length) throw new Error('query has no usable keywords')
    const maxResults = Math.max(1, Math.floor(asNumber(input.max_results ?? input.maxResults, 20)))
    const maxFiles = Math.max(1, Math.floor(asNumber(input.max_files ?? input.maxFiles, 5000)))
    const ranked: Array<{ file: string; score: number; snippet: string }> = []
    for await (const file of walkFiles(root, maxFiles)) {
      if (!(await isTextFile(file))) continue
      const content = await readTextFile(file, 512 * 1024).catch(() => '')
      const lower = content.toLowerCase()
      let score = 0
      let firstIndex = -1
      for (const term of terms) {
        const idx = lower.indexOf(term)
        if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) firstIndex = idx
        score += lower.split(term).length - 1
      }
      if (score <= 0) continue
      const start = Math.max(0, firstIndex - 120)
      const snippet = content.slice(start, start + 360).replace(/\s+/g, ' ').trim()
      ranked.push({ file, score, snippet })
    }
    ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    return {
      data: ranked.slice(0, maxResults)
        .map((item, index) => `${index + 1}. ${item.file} (score ${item.score})\n${item.snippet}`)
        .join('\n\n') || '(no matches)',
    }
  },
})

const runCommandTool = baseTool<typeof runCommandSchema, AgnetShellProgress>({
  name: 'run_command',
  searchHint: 'execute a shell command',
  inputSchema: runCommandSchema,
  isReadOnly: () => false,
  isDestructive: () => true,
  async description(input) {
    return `Run ${commandFrom(input) || 'a shell command'}`
  },
  async prompt() {
    return "Execute a shell command and return stdout+stderr+exit code. Default shell: PowerShell on Windows, /bin/sh on Unix. Command runs in the current working directory unless working_directory is set."
  },
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const command = commandFrom(input)
    if (!command) return { data: 'not run; command is required' }
    const cwd = await resolveWorkPath(pickString(input, 'working_directory', 'workingDirectory', 'cwd', 'workdir'))
    const timeoutMs = Math.max(1, asNumber(input.timeout_sec ?? input.timeoutSec ?? input.timeout, 300)) * 1000
    const isWindows = process.platform === 'win32'
    const startedAt = Date.now()
    const taskId = `run-command-${Date.now()}-${runCommandProgressCounter++}`
    const progressType: ShellProgressType = isWindows ? 'powershell_progress' : 'bash_progress'
    const child = spawn(
      isWindows ? 'powershell.exe' : '/bin/sh',
      isWindows
        ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powerShellCommandWithUtf8(command)]
        : ['-c', command],
      { cwd, windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    let mergedOutput = ''
    let lastProgressOutput = ''
    const emitProgress = (output = '') => {
      if (!onProgress) return
      const fullOutput = tailForProgress(mergedOutput)
      onProgress({
        toolUseID: `${taskId}-progress-${runCommandProgressCounter++}`,
        data: {
          type: progressType,
          output,
          fullOutput,
          elapsedTimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
          totalLines: countLines(mergedOutput),
          totalBytes: Buffer.byteLength(mergedOutput, 'utf8'),
          timeoutMs,
          taskId,
        },
      })
    }
    const appendOutput = (chunk: unknown, target: 'stdout' | 'stderr') => {
      const text = String(chunk)
      if (target === 'stdout') stdout += text
      else stderr += text
      mergedOutput += text
      lastProgressOutput += text
      emitProgress(lastProgressOutput)
      lastProgressOutput = ''
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => appendOutput(chunk, 'stdout'))
    child.stderr.on('data', chunk => appendOutput(chunk, 'stderr'))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const progressTimer = onProgress
      ? setInterval(() => {
        emitProgress(lastProgressOutput)
        lastProgressOutput = ''
      }, 1000)
      : null
    context.abortController.signal.addEventListener('abort', () => child.kill(), { once: true })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
    clearTimeout(timer)
    if (progressTimer) clearInterval(progressTimer)
    emitProgress(lastProgressOutput)
    const outputText = mergedOutput || `${stdout}${stderr}`
    return { data: `${outputText}${outputText ? '\n' : ''}exit code: ${exitCode ?? 'terminated'}` }
  },
})

const webFetchTool = baseTool({
  name: 'web_fetch',
  searchHint: 'fetch a URL',
  inputSchema: webFetchSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Fetch ${requestUrlFrom(input)}`
  },
  async prompt() {
    return 'Fetch a URL and return its content. HTML pages are converted to plain text (scripts/styles removed). Non-HTML responses are returned as raw text. Max 1MB body.'
  },
  async call(input) {
    const url = requestUrlFrom(input)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, asNumber(input.timeout_sec ?? input.timeoutSec, 30)) * 1000)
    try {
      const { status, headers, body } = await fetchText(url, { signal: controller.signal })
      const contentType = headers.get('content-type') ?? ''
      const text = contentType.includes('html') ? stripHtml(body) : body
      return { data: `HTTP ${status}\n${text}` }
    } finally {
      clearTimeout(timer)
    }
  },
})

const webSearchTool = baseTool({
  name: 'web_search',
  searchHint: 'search the web',
  inputSchema: webSearchSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Search web for ${pickString(input, 'query', 'q') || 'a query'}`
  },
  async prompt() {
    return 'Web search. Uses DuckDuckGo HTML search by default and returns ranked results with title, url, snippet.'
  },
  async validateInput(input) {
    if (!pickString(input, 'query', 'q')) return { result: false, message: 'query is required', errorCode: 1 }
    return { result: true }
  },
  async call(input) {
    const query = pickString(input, 'query', 'q')
    const url = new URL('https://duckduckgo.com/html/')
    url.searchParams.set('q', query)
    const max = Math.max(1, Math.floor(asNumber(input.max_results ?? input.maxResults, 10)))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, asNumber(input.timeout_sec ?? input.timeoutSec, 30)) * 1000)
    try {
      const { body } = await fetchText(url.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      })
      const matches = [...body.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
      const rows = matches.slice(0, max).map((match, index) => {
        const resultUrl = stripHtml(match[1] ?? '')
        const title = stripHtml(match[2] ?? '')
        const snippet = stripHtml(match[3] ?? '')
        return `${index + 1}. ${title}\n${resultUrl}\n${snippet}`
      })
      return { data: rows.join('\n\n') || '(no results)' }
    } finally {
      clearTimeout(timer)
    }
  },
})

const jinaReaderTool = baseTool({
  name: 'jina_reader',
  searchHint: 'fetch readable markdown from a URL',
  inputSchema: jinaReaderSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Read ${requestUrlFrom(input)} with Jina`
  },
  async prompt() {
    return 'Fetch a URL via Jina AI Reader (r.jina.ai) and return clean markdown. Much better than web_fetch for complex/JS-heavy pages.'
  },
  async call(input) {
    const target = requestUrlFrom(input).replace(/^https?:\/\//i, '')
    const finalUrl = `https://r.jina.ai/http://${target}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, asNumber(input.timeout_sec ?? input.timeoutSec, 30)) * 1000)
    try {
      const { status, body } = await fetchText(finalUrl, { signal: controller.signal })
      return { data: `HTTP ${status}\n${body}` }
    } finally {
      clearTimeout(timer)
    }
  },
})

const httpRequestTool = baseTool({
  name: 'http_request',
  searchHint: 'make an HTTP request',
  inputSchema: httpRequestSchema,
  isConcurrencySafe: () => true,
  isReadOnly: input => !['POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethodFrom(input).toUpperCase()),
  isDestructive: input => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethodFrom(input).toUpperCase()),
  async description(input) {
    return `${httpMethodFrom(input).toUpperCase()} ${requestUrlFrom(input) || 'a URL'}`
  },
  async prompt() {
    return 'Generic HTTP client. Make any HTTP/HTTPS request. Returns status code, response headers, and body.'
  },
  async call(input) {
    const url = requestUrlFrom(input)
    if (!url) return { data: 'not requested; url is required' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, asNumber(input.timeout_sec ?? input.timeoutSec, 30)) * 1000)
    try {
      const headers: Record<string, string> = {
        ...stringHeadersFrom(input.headers),
        Accept: typeof input.accept === 'string' ? input.accept : '*/*',
      }
      const requestBody = stringBodyFrom(input.body ?? input.json)
      if (requestBody !== undefined) headers['Content-Type'] = input.content_type ?? input.contentType ?? 'application/json'
      const authHeader = input.auth_header ?? input.authHeader
      if (authHeader) headers.Authorization = authHeader
      const { status, headers: responseHeaders, body: responseBody } = await fetchText(url, {
        method: httpMethodFrom(input).toUpperCase(),
        headers,
        body: requestBody,
        redirect: asBoolean(input.follow_redirects ?? input.followRedirects, true) ? 'follow' : 'manual',
        signal: controller.signal,
      })
      const headerText = [...responseHeaders.entries()].map(([key, value]) => `${key}: ${value}`).join('\n')
      return { data: `HTTP ${status}\n${headerText}\n\n${responseBody}` }
    } finally {
      clearTimeout(timer)
    }
  },
})

const todoWriteTool = baseTool({
  name: 'todo_write',
  searchHint: 'write a persistent todo list',
  inputSchema: todoWriteSchema,
  isReadOnly: () => false,
  async description() {
    return 'Write todo list'
  },
  async prompt() {
    return 'Overwrite the persistent todo list with the given items. Status must be one of: pending, in_progress, completed. Stored at <data_dir>/todos.json.'
  },
  async call(input) {
    const todos = parseTodos(input.todos ?? input.items ?? input.tasks ?? input.raw)
    await fs.mkdir(dataDir(), { recursive: true })
    await fs.writeFile(todosPath(), JSON.stringify(todos, null, 2), 'utf8')
    return { data: `wrote ${todos.length} todo(s)` }
  },
})

const todoReadTool = baseTool({
  name: 'todo_read',
  searchHint: 'read the persistent todo list',
  inputSchema: emptySchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description() {
    return 'Read todo list'
  },
  async prompt() {
    return 'Read the current persistent todo list.'
  },
  async call() {
    const raw = await fs.readFile(todosPath(), 'utf8').catch(() => '')
    if (!raw) return { data: '(no todos)' }
    const todos = JSON.parse(raw) as Array<{ content: string; status: string }>
    return { data: todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join('\n') || '(no todos)' }
  },
})

const todoClearTool = baseTool({
  name: 'todo_clear',
  searchHint: 'clear the persistent todo list',
  inputSchema: emptySchema,
  isReadOnly: () => false,
  async description() {
    return 'Clear todo list'
  },
  async prompt() {
    return 'Clear the persistent todo list.'
  },
  async call() {
    await fs.unlink(todosPath()).catch(() => {})
    return { data: 'cleared' }
  },
})

const notesWriteTool = baseTool({
  name: 'notes_write',
  searchHint: 'write a named note',
  inputSchema: notesWriteSchema,
  isReadOnly: () => false,
  async description(input) {
    return `Write note ${noteNameFrom(input)}`
  },
  async prompt() {
    return 'Write a named note. Name must match [A-Za-z0-9._-]+. Stored at <data_dir>/notes/<name>.md.'
  },
  async call(input) {
    const name = noteNameFrom(input)
    const content = noteContentFrom(input)
    assertNoteName(name)
    await fs.mkdir(notesDir(), { recursive: true })
    const file = path.join(notesDir(), `${name}.md`)
    await fs.writeFile(file, content, 'utf8')
    return { data: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${file}` }
  },
})

const notesReadTool = baseTool({
  name: 'notes_read',
  searchHint: 'read a named note',
  inputSchema: noteNameSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description(input) {
    return `Read note ${noteNameFrom(input)}`
  },
  async prompt() {
    return 'Read a named note.'
  },
  async call(input) {
    const name = noteNameFrom(input)
    assertNoteName(name)
    return { data: await fs.readFile(path.join(notesDir(), `${name}.md`), 'utf8') }
  },
})

const notesListTool = baseTool({
  name: 'notes_list',
  searchHint: 'list note names',
  inputSchema: emptySchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async description() {
    return 'List notes'
  },
  async prompt() {
    return 'List all note names.'
  },
  async call() {
    const entries = await fs.readdir(notesDir(), { withFileTypes: true }).catch(() => [])
    const names = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name.slice(0, -3))
      .sort()
    return { data: names.join('\n') || '(no notes)' }
  },
})

const notesDeleteTool = baseTool({
  name: 'notes_delete',
  searchHint: 'delete a named note',
  inputSchema: noteNameSchema,
  isReadOnly: () => false,
  isDestructive: () => true,
  async description(input) {
    return `Delete note ${noteNameFrom(input)}`
  },
  async prompt() {
    return 'Delete a named note.'
  },
  async call(input) {
    const name = noteNameFrom(input)
    assertNoteName(name)
    await fs.unlink(path.join(notesDir(), `${name}.md`))
    return { data: 'deleted' }
  },
})

export const AgnetCompatTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  listDirTool,
  grepTool,
  globTool,
  codebaseSearchTool,
  runCommandTool,
  webFetchTool,
  webSearchTool,
  jinaReaderTool,
  httpRequestTool,
  todoWriteTool,
  todoReadTool,
  todoClearTool,
  notesWriteTool,
  notesReadTool,
  notesListTool,
  notesDeleteTool,
]
