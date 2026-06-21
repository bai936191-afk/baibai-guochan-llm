import { describe, expect, it } from 'vitest'
import { stripAssistantToolProtocolText } from './assistantProtocolText'

describe('stripAssistantToolProtocolText', () => {
  it('removes standalone text-mode tool call lines while keeping prose', () => {
    expect(
      stripAssistantToolProtocolText('让我验证一下。\n\n[Tool Call id=call_00_abc]\n'),
    ).toBe('让我验证一下。')
  })

  it('hides raw text-mode tool result payloads', () => {
    expect(
      stripAssistantToolProtocolText(
        '[Tool Result for call_00_abc]\nstatus=completed\n1 const value = true',
      ),
    ).toBe('')
  })

  it('cuts raw tool result payloads appended after visible prose', () => {
    expect(
      stripAssistantToolProtocolText(
        '读取完成。\n\n[Tool Result for call_00_abc]\nstatus=completed\n1 const value = true',
      ),
    ).toBe('读取完成。')
  })

  it('hides synthetic interruption markers', () => {
    expect(stripAssistantToolProtocolText('[Request interrupted by user]')).toBe('')
    expect(stripAssistantToolProtocolText('[Request interrupted by user for tool use]')).toBe('')
  })
})
