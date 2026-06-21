import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AgnetCompatTools } from './AgnetCompatTools.js'
import type { Tool } from '../../Tool.js'

let tmpDir = ''
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agnet-tools-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function getTool(name: string): Tool {
  const tool = AgnetCompatTools.find(item => item.name === name || item.aliases?.includes(name))
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

async function callTool(
  tool: Tool,
  input: Record<string, unknown>,
  onProgress?: Parameters<Tool['call']>[4],
) {
  return tool.call(
    input,
    {
      abortController: new AbortController(),
    } as never,
    (() => Promise.resolve({ behavior: 'allow', updatedInput: input })) as never,
    { uuid: crypto.randomUUID() } as never,
    onProgress,
  )
}

describe('AgnetCompatTools compatibility inputs', () => {
  test('exports the full built-in tool surface expected by the model', () => {
    const expected = [
      'codebase_search',
      'delete_file',
      'edit_file',
      'glob',
      'grep',
      'http_request',
      'jina_reader',
      'list_dir',
      'notes_delete',
      'notes_list',
      'notes_read',
      'notes_write',
      'read_file',
      'run_command',
      'todo_clear',
      'todo_read',
      'todo_write',
      'web_fetch',
      'web_search',
      'write_file',
    ].sort()

    expect(AgnetCompatTools.map(tool => tool.name).sort()).toEqual(expected)
  })

  test('all built-in agent tool schemas tolerate harmless extra model arguments', () => {
    const sampleInputs: Record<string, Record<string, unknown>> = {
      codebase_search: { query: 'agent tools', path: tmpDir },
      delete_file: { path: path.join(tmpDir, 'missing.txt') },
      edit_file: { path: path.join(tmpDir, 'missing.txt'), old_string: '', new_string: '' },
      glob: { pattern: '**/*.txt', path: tmpDir },
      grep: { pattern: 'agent', path: tmpDir },
      http_request: { target_url: 'https://example.com', headers: { count: 1 } },
      jina_reader: { target_url: 'https://example.com' },
      list_dir: { target_directory: tmpDir },
      notes_delete: { note_name: 'note' },
      notes_list: {},
      notes_read: { note_name: 'note' },
      notes_write: { note_name: 'note', body: '' },
      read_file: { target_file: path.join(tmpDir, 'missing.txt') },
      run_command: { cmd: 'echo ok' },
      todo_clear: {},
      todo_read: {},
      todo_write: { raw: '[]' },
      web_fetch: { url: 'https://example.com', prompt: 'summarize' },
      web_search: { query: 'today hot search', max_results: '8' },
      write_file: { target_file: path.join(tmpDir, 'empty.txt'), content: '' },
    }

    for (const tool of AgnetCompatTools) {
      const parsed = tool.inputSchema.safeParse({
        ...sampleInputs[tool.name],
        prompt: 'model may add a prompt field',
        max_results: '8',
        target_file: sampleInputs[tool.name]?.target_file,
      })
      expect(parsed.success, `${tool.name} should accept compatibility input`).toBe(true)
    }
  })

  test('web_search accepts numeric arguments emitted as strings', () => {
    const tool = getTool('web_search')
    const parsed = tool.inputSchema.safeParse({
      query: '百度热搜 今日 2026年6月',
      max_results: '8',
    })

    expect(parsed.success).toBe(true)
  })

  test('grep accepts -i and string limits without input validation errors', async () => {
    const file = path.join(tmpDir, 'hot.txt')
    await fs.writeFile(file, 'Baidu hot\nother\n', 'utf8')

    const tool = getTool('grep')
    const input = {
      '-i': 'true',
      output_mode: 'files_with_matches',
      pattern: 'baidu',
      path: tmpDir,
      max_results: '8',
    }
    const parsed = tool.inputSchema.safeParse(input)
    expect(parsed.success).toBe(true)

    const result = await callTool(tool, input)
    expect(String(result.data)).toContain(file)
  })

  test('read_file accepts target_file and string offset or limit', async () => {
    const file = path.join(tmpDir, 'sample.txt')
    await fs.writeFile(file, 'one\ntwo\nthree\n', 'utf8')

    const tool = getTool('read_file')
    const input = {
      target_file: file,
      offset: '2',
      limit: '1',
    }
    const parsed = tool.inputSchema.safeParse(input)
    expect(parsed.success).toBe(true)

    const result = await callTool(tool, input)
    expect(String(result.data)).toContain('two')
    expect(String(result.data)).not.toContain('one')
  })

  test('web_fetch accepts prompt as a harmless compatibility field', () => {
    const tool = getTool('web_fetch')
    const parsed = tool.inputSchema.safeParse({
      url: 'https://example.com',
      prompt: 'summarize the page',
    })

    expect(parsed.success).toBe(true)
  })

  test('run_command accepts common command aliases and missing command stays soft', async () => {
    const tool = getTool('run_command')
    expect(tool.inputSchema.safeParse({
      cmd: process.platform === 'win32' ? 'Write-Output alias-ok' : 'printf alias-ok',
      timeout_sec: '5',
    }).success).toBe(true)

    expect((await callTool(tool, {
      shell_command: process.platform === 'win32' ? 'Write-Output alias-ok' : 'printf alias-ok',
      cwd: tmpDir,
      timeout_sec: '5',
    })).data).toContain('alias-ok')

    expect((await callTool(tool, {
      cwd: tmpDir,
    })).data).toContain('command is required')
  })

  test('http_request accepts URL aliases and non-string header values', () => {
    const tool = getTool('http_request')
    const parsed = tool.inputSchema.safeParse({
      target_url: 'https://example.com/api',
      method: 'POST',
      headers: {
        'x-count': 3,
        'x-enabled': true,
      },
      json: { ok: true },
      timeout_sec: '10',
    })

    expect(parsed.success).toBe(true)
  })

  test('write_file preserves intentionally empty content', async () => {
    const file = path.join(tmpDir, 'empty.txt')
    const result = await callTool(getTool('write_file'), {
      path: file,
      content: '',
    })

    expect(result.data).toContain('0 line')
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('')
  })

  test('edit_file returns non-destructive output instead of throwing when context is stale', async () => {
    const file = path.join(tmpDir, 'stale.txt')
    await fs.writeFile(file, 'current text\n', 'utf8')

    const result = await callTool(getTool('edit_file'), {
      path: file,
      old_string: 'old text',
      new_string: 'new text',
    })

    expect(result.data).toContain('not modified')
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('current text\n')
  })

  test('edit_file tolerates CRLF/LF differences safely', async () => {
    const file = path.join(tmpDir, 'line-endings.txt')
    await fs.writeFile(file, 'alpha\r\nbeta\r\n', 'utf8')

    const result = await callTool(getTool('edit_file'), {
      path: file,
      old_string: 'alpha\nbeta',
      new_string: 'gamma\nbeta',
    })

    expect(result.data).toContain('line-ending-insensitive')
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('gamma\nbeta\r\n')
  })

  test('todo_write accepts JSON array strings from tool-call arguments', async () => {
    const tool = getTool('todo_write')
    const input = {
      raw: JSON.stringify([
        { content: '探索代码库结构', status: 'in_progress' },
        { content: '汇总测试结果', status: 'pending' },
      ]),
    }
    const parsed = tool.inputSchema.safeParse(input)
    expect(parsed.success).toBe(true)

    const result = await callTool(tool, input)
    expect(String(result.data)).toContain('wrote 2 todo')
  })

  test('run_command streams live progress output before returning the final result', async () => {
    const progressEvents: Array<{ data: { fullOutput?: string; output?: string } }> = []
    const command = process.platform === 'win32'
      ? 'Write-Output progress-ok; Start-Sleep -Milliseconds 1200; Write-Output done'
      : 'printf "progress-ok\\n"; sleep 1; printf "done\\n"'

    const result = await callTool(
      getTool('run_command'),
      {
        command,
        cwd: tmpDir,
        timeout_sec: '10',
      },
      progress => {
        progressEvents.push(progress as never)
      },
    )

    expect(result.data).toContain('progress-ok')
    expect(progressEvents.some(event => event.data.fullOutput?.includes('progress-ok'))).toBe(true)
  })

  test('glob_path remains available as an alias for glob', () => {
    expect(getTool('glob_path').name).toBe('glob')
  })

  test('file and shell tools support multilingual paths and unique Unicode path recovery', async () => {
    const unicodeRoot = path.join(tmpDir, '测试AI')
    const nested = path.join(unicodeRoot, '多语言目录')
    const file = path.join(nested, '说明-文件.txt')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(file, '第一行\nagent 多语言路径\n', 'utf8')

    const truncatedRoot = path.join(tmpDir, 'AI')

    expect((await callTool(getTool('list_dir'), {
      path: truncatedRoot,
      depth: '2',
    })).data).toContain('多语言目录')

    expect((await callTool(getTool('read_file'), {
      target_file: file,
    })).data).toContain('agent 多语言路径')

    expect((await callTool(getTool('grep'), {
      pattern: '多语言',
      path: truncatedRoot,
      output_mode: 'content',
    })).data).toContain(file)

    expect((await callTool(getTool('glob'), {
      glob_path: '**/*文件.txt',
      root: truncatedRoot,
    })).data).toContain(file)

    expect((await callTool(getTool('codebase_search'), {
      query: 'agent 多语言',
      root: truncatedRoot,
    })).data).toContain(file)

    const newFile = path.join(truncatedRoot, '新建-资料.txt')
    const actualNewFile = path.join(unicodeRoot, '新建-资料.txt')
    expect((await callTool(getTool('write_file'), {
      path: newFile,
      content: '写入成功\n',
    })).data).toContain(actualNewFile)
    await expect(fs.readFile(actualNewFile, 'utf8')).resolves.toContain('写入成功')

    expect((await callTool(getTool('edit_file'), {
      path: actualNewFile,
      old_string: '写入成功',
      new_string: '修改成功',
    })).data).toContain('replacements: 1')

    const shellResult = await callTool(getTool('run_command'), {
      command: process.platform === 'win32'
        ? '$PWD.Path'
        : 'pwd',
      cwd: truncatedRoot,
      timeout_sec: '5',
    })
    expect(String(shellResult.data)).toContain(unicodeRoot)

    expect((await callTool(getTool('delete_file'), {
      path: actualNewFile,
    })).data).toContain('修改成功')
  })

  test('local file, search, shell, todo, notes, and http tools execute successfully', async () => {
    const source = path.join(tmpDir, 'src')
    const file = path.join(source, 'sample.txt')
    await fs.mkdir(source, { recursive: true })

    let server: ReturnType<typeof Bun.serve> | null = null
    try {
      server = Bun.serve({
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === '/html') {
            return new Response('<html><body><h1>tool-ok</h1></body></html>', {
              headers: { 'Content-Type': 'text/html' },
            })
          }
          return Response.json({ ok: true, method: req.method })
        },
      })

      expect((await callTool(getTool('write_file'), {
        target_file: file,
        text: 'alpha\nbeta agent\n',
      })).data).toContain('created')

      expect((await callTool(getTool('read_file'), {
        filePath: file,
      })).data).toContain('beta agent')

      expect((await callTool(getTool('edit_file'), {
        file_path: file,
        old: 'beta agent',
        replacement: 'gamma agent',
      })).data).toContain('replacements: 1')

      expect((await callTool(getTool('list_dir'), {
        targetDirectory: tmpDir,
        depth: '2',
      })).data).toContain('sample.txt')

      expect((await callTool(getTool('grep'), {
        query: 'gamma',
        directory: tmpDir,
        output_mode: 'content',
      })).data).toContain('gamma agent')

      expect((await callTool(getTool('glob'), {
        glob_path: '**/*.txt',
        root: tmpDir,
      })).data).toContain('sample.txt')

      expect((await callTool(getTool('codebase_search'), {
        text: 'gamma agent',
        root: tmpDir,
      })).data).toContain('sample.txt')

      expect((await callTool(getTool('run_command'), {
        command: 'echo tool-ok',
        cwd: tmpDir,
        timeout_sec: '5',
      })).data).toContain('tool-ok')

      expect((await callTool(getTool('todo_write'), {
        items: [{ content: 'check tools', status: 'completed' }],
      })).data).toContain('wrote 1 todo')
      expect((await callTool(getTool('todo_read'), {})).data).toContain('check tools')
      expect((await callTool(getTool('todo_clear'), {})).data).toContain('cleared')

      expect((await callTool(getTool('notes_write'), {
        note_name: 'tool-note',
        text: 'note-ok',
      })).data).toContain('wrote')
      expect((await callTool(getTool('notes_list'), {})).data).toContain('tool-note')
      expect((await callTool(getTool('notes_read'), {
        note: 'tool-note',
      })).data).toContain('note-ok')
      expect((await callTool(getTool('notes_delete'), {
        title: 'tool-note',
      })).data).toContain('deleted')

      const baseUrl = server.url.toString().replace(/\/$/, '')
      expect((await callTool(getTool('web_fetch'), {
        target_url: `${baseUrl}/html`,
      })).data).toContain('tool-ok')
      expect((await callTool(getTool('http_request'), {
        method: 'POST',
        url: `${baseUrl}/json`,
        json: { hello: 'world' },
      })).data).toContain('"ok":true')

      expect(getTool('jina_reader').inputSchema.safeParse({
        target_url: 'https://example.com',
        repair_gbk: 'false',
      }).success).toBe(true)
      expect(getTool('web_search').inputSchema.safeParse({
        query: 'today hot search',
        max_results: '8',
      }).success).toBe(true)

      expect((await callTool(getTool('delete_file'), {
        targetFile: file,
      })).data).toContain('deleted')
    } finally {
      server?.stop(true)
    }
  })
})
