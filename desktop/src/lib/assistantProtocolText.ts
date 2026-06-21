function isToolCallProtocolLine(line: string): boolean {
  return /^\[Tool Call id=[^\]]*\]?$/.test(line.trim())
}

function isToolResultProtocolLine(line: string): boolean {
  return /^\[Tool Result for [^\]]*\]?$/.test(line.trim())
}

function isSyntheticInterruptionLine(line: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(line.trim())
}

function trimProtocolWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}$/g, '\n\n')
    .trimEnd()
}

export function stripAssistantToolProtocolText(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return ''

  const lines = normalized.split('\n')
  const nonEmptyLines = lines.filter((line) => line.trim())
  const hasProtocolLine = nonEmptyLines.some(
    (line) =>
      isToolCallProtocolLine(line) ||
      isToolResultProtocolLine(line) ||
      isSyntheticInterruptionLine(line),
  )
  if (!hasProtocolLine) return content

  if (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every(
      (line) =>
        isToolCallProtocolLine(line) ||
        isToolResultProtocolLine(line) ||
        isSyntheticInterruptionLine(line),
    )
  ) {
    return ''
  }

  const firstNonEmpty = nonEmptyLines[0]
  if (firstNonEmpty && isToolResultProtocolLine(firstNonEmpty)) {
    return ''
  }

  const toolResultIndex = lines.findIndex((line) => isToolResultProtocolLine(line))
  const visibleLines = toolResultIndex >= 0 ? lines.slice(0, toolResultIndex) : lines
  const filteredLines = visibleLines.filter(
    (line) =>
      !isToolCallProtocolLine(line) &&
      !isSyntheticInterruptionLine(line),
  )

  return trimProtocolWhitespace(filteredLines.join('\n'))
}
