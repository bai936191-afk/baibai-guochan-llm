import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { attributionHeaderEnvForModel } from '../services/attributionHeaderPolicy.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const
const DEFAULT_EFFORT = 'max'

const settingsService = new SettingsService()
const providerService = new ProviderService()

type ApiModelInfo = {
  id: string
  name: string
  description: string
  context: string
  capabilities?: string[]
}

type ProviderRoleModels = {
  main: string
  haiku: string
  sonnet: string
  opus: string
}

type ProviderAvailableModel = {
  id: string
  contextWindow?: number
  capabilities?: string[]
}

function formatContextWindow(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return ''
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}m`
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`
  return String(value)
}

function addUniqueModel(models: ApiModelInfo[], model: ApiModelInfo | null): void {
  if (!model || !model.id.trim()) return
  if (models.some(existing => existing.id === model.id)) return
  models.push(model)
}

function buildProviderModelList(
  models: ProviderRoleModels,
  contextWindows: Record<string, number> = {},
  availableModels: ProviderAvailableModel[] = [],
): ApiModelInfo[] {
  const modelList: ApiModelInfo[] = []
  const roleLabels = new Map<string, string[]>()
  const includeRoleLabels = availableModels.length === 0

  const addRole = (id: string, label: string) => {
    if (!includeRoleLabels) return
    const trimmed = id.trim()
    if (!trimmed) return
    const labels = roleLabels.get(trimmed) ?? []
    if (!labels.includes(label)) labels.push(label)
    roleLabels.set(trimmed, labels)
  }
  addRole(models.main, 'Main model')
  addRole(models.haiku, 'Haiku model')
  addRole(models.sonnet, 'Sonnet model')
  addRole(models.opus, 'Opus model')

  const addProviderModel = (
    id: string,
    explicitContextWindow?: number,
    capabilities?: string[],
  ) => {
    const trimmed = id.trim()
    if (!trimmed) return
    const labels = roleLabels.get(trimmed) ?? []
    const contextWindow = explicitContextWindow ?? contextWindows[trimmed]
    addUniqueModel(modelList, {
      id: trimmed,
      name: trimmed,
      description: labels.length > 0 ? labels.join(' / ') : 'Available model',
      context: formatContextWindow(contextWindow),
      ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
    })
  }

  for (const model of availableModels) {
    addProviderModel(model.id, model.contextWindow, model.capabilities)
  }
  addProviderModel(models.main, contextWindows[models.main])
  addProviderModel(models.haiku, contextWindows[models.haiku])
  addProviderModel(models.sonnet, contextWindows[models.sonnet])
  addProviderModel(models.opus, contextWindows[models.opus])

  return modelList
}

function normalizeEffortLevel(value: unknown): (typeof EFFORT_LEVELS)[number] {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as (typeof EFFORT_LEVELS)[number])
    ? value as (typeof EFFORT_LEVELS)[number]
    : DEFAULT_EFFORT
}

export async function handleModelsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  void url
  try {
    const resource = segments[1]
    const sub = segments[2]

    if (resource === 'effort') {
      return await handleEffort(req)
    }

    switch (sub) {
      case undefined:
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return await handleModelsList()

      case 'current':
        return await handleCurrentModel(req)

      default:
        throw ApiError.notFound(`Unknown models endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleModelsList(): Promise<Response> {
  const activeProvider = await providerService.refreshActiveProviderModels()
  if (!activeProvider) {
    return Response.json({ models: [], provider: null })
  }

  return Response.json({
    models: buildProviderModelList(
      activeProvider.models,
      activeProvider.modelContextWindows ?? {},
      activeProvider.availableModels ?? [],
    ),
    provider: { id: activeProvider.id, name: activeProvider.name },
  })
}

async function handleCurrentModel(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const activeProvider = await providerService.refreshActiveProviderModels()
    const settings = activeProvider
      ? await providerService.getManagedSettings()
      : await settingsService.getUserSettings()
    const explicitModel = (settings.model as string) || ''
    const contextTier = (settings.modelContext as string) || undefined
    const env = (settings.env as Record<string, string>) || {}

    const providerEnvModel = env.ANTHROPIC_MODEL
    const currentModelId = activeProvider
      ? explicitModel || providerEnvModel || activeProvider.models.main
      : explicitModel
    const currentModelName = currentModelId
    const lookupId = contextTier ? `${currentModelId}:${contextTier}` : currentModelId
    const availableModels = activeProvider
      ? buildProviderModelList(
          activeProvider.models,
          activeProvider.modelContextWindows ?? {},
          activeProvider.availableModels ?? [],
        )
      : []

    const modelEntry = availableModels.find((m) => m.id === lookupId)
      || availableModels.find((m) => m.id === currentModelId)
      || {
        id: currentModelId,
        name: currentModelName,
        description: currentModelId ? 'Custom model' : '',
        context: contextTier || '',
      }

    return Response.json({ model: { ...modelEntry, context: contextTier || modelEntry.context } })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const modelId = body.modelId
    if (typeof modelId !== 'string' || !modelId) {
      throw ApiError.badRequest('Missing or invalid "modelId" in request body')
    }

    const colonIdx = modelId.indexOf(':')
    const baseId = colonIdx !== -1 ? modelId.slice(0, colonIdx) : modelId
    const contextTier = colonIdx !== -1 ? modelId.slice(colonIdx + 1) : undefined

    const updates: Record<string, unknown> = { model: baseId }
    updates.modelContext = contextTier

    const { activeId } = await providerService.listProviders()
    if (activeId) {
      const currentManagedSettings = await providerService.getManagedSettings()
      const currentEnv =
        (currentManagedSettings.env as Record<string, string> | undefined) ?? {}
      await providerService.updateManagedSettings({
        ...updates,
        env: {
          ...currentEnv,
          ...attributionHeaderEnvForModel(baseId),
        },
      })
    } else {
      await settingsService.updateUserSettings(updates)
    }
    return Response.json({ ok: true, model: modelId })
  }

  throw methodNotAllowed(req.method)
}

async function handleEffort(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const level = normalizeEffortLevel(settings.effort)
    return Response.json({ level, available: EFFORT_LEVELS })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const level = body.level
    if (typeof level !== 'string') {
      throw ApiError.badRequest('Missing or invalid "level" in request body')
    }
    if (!EFFORT_LEVELS.includes(level as (typeof EFFORT_LEVELS)[number])) {
      throw ApiError.badRequest(
        `Invalid effort level: "${level}". Valid levels: ${EFFORT_LEVELS.join(', ')}`,
      )
    }
    await settingsService.updateUserSettings({ effort: level })
    return Response.json({ ok: true, level })
  }

  throw methodNotAllowed(req.method)
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
