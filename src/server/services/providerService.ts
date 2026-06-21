/**
 * Provider Service — preset-based provider configuration
 *
 * Storage: ~/.claude/cc-haha/providers.json (lightweight index)
 * Active provider env vars written to ~/.claude/cc-haha/settings.json
 * (isolated from the original Claude Code's ~/.claude/settings.json)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ApiError } from '../middleware/errorHandler.js'
import { readRecoverableJsonFile } from './recoverableJsonFile.js'
import { ManagedSettingsService } from './managedSettingsService.js'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from '../proxy/transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from '../proxy/transform/openaiResponsesToAnthropic.js'
import type { AnthropicRequest, AnthropicResponse } from '../proxy/transform/types.js'
import {
  OPENAI_OFFICIAL_PROVIDER,
  isOpenAIOfficialProviderId,
} from './openaiOfficialProvider.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import {
  CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
  ensurePersistentStorageUpgraded,
} from './persistentStorageMigrations.js'
import {
  buildProviderAuthEnv,
  buildProviderManagedEnv,
  getManagedEnvKeys,
  getPresetAuthStrategy,
  getPresetDefaultEnv,
  normalizeModelMapping,
  normalizeProvidersIndex,
} from './providerRuntimeEnv.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import {
  getManualNetworkProxyUrl,
  loadNetworkSettings,
  type NetworkSettings,
} from './networkSettings.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import type {
  SavedProvider,
  ProvidersIndex,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderInput,
  ProviderTestResult,
  ProviderTestStepResult,
  ApiFormat,
  ProviderAuthStrategy,
} from '../types/provider.js'
import {
  BUILT_IN_PROVIDER_IDS,
} from '../types/provider.js'

const DEFAULT_INDEX: ProvidersIndex = {
  schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
  activeId: null,
  providers: [],
  providerOrder: [...BUILT_IN_PROVIDER_IDS],
}

const PROVIDER_MODEL_REFRESH_MIN_INTERVAL_MS = 2_000
const providerModelRefreshTimestamps = new Map<string, number>()
const providerModelRefreshInFlight = new Map<string, Promise<SavedProvider | null>>()

type NormalizedProviderModel = {
  id: string
  contextWindow?: number
  capabilities?: string[]
}

function isPermutation(candidateIds: string[], expectedIds: string[]): boolean {
  const expectedSet = new Set(expectedIds)
  const candidateSet = new Set(candidateIds)
  return (
    candidateIds.length === expectedIds.length &&
    candidateSet.size === candidateIds.length &&
    expectedIds.every((id) => candidateSet.has(id)) &&
    candidateIds.every((id) => expectedSet.has(id))
  )
}

function savedProviderIds(providers: SavedProvider[]): string[] {
  return providers.map((provider) => provider.id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function fullProviderOrderIds(providers: SavedProvider[]): string[] {
  return savedProviderIds(providers)
}

function shouldAutoRefreshProviderModels(provider: SavedProvider): boolean {
  if (provider.runtimeKind === 'openai_oauth') return false
  if (!provider.baseUrl.trim() || !provider.apiKey.trim()) return false
  if (/^\*+$/.test(provider.apiKey.trim())) return false
  return true
}

function modelContextWindowsFromModels(models: NormalizedProviderModel[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const model of models) {
    const id = model.id.trim()
    if (!id || model.contextWindow === undefined) continue
    result[id] = model.contextWindow
  }
  return result
}

function chooseProviderModelMapping(
  provider: SavedProvider,
  models: NormalizedProviderModel[],
): SavedProvider['models'] {
  const availableIds = new Set(models.map((model) => model.id.trim()).filter(Boolean))
  const firstAvailableModel = models.find((model) => model.id.trim())?.id.trim()
  const choose = (current: string, fallback: string): string => {
    const trimmed = current.trim()
    return trimmed && availableIds.has(trimmed) ? trimmed : fallback
  }
  const main = choose(provider.models.main, firstAvailableModel ?? provider.models.main)

  return {
    main,
    haiku: choose(provider.models.haiku, main),
    sonnet: choose(provider.models.sonnet, main),
    opus: choose(provider.models.opus, main),
  }
}

function sortSavedProvidersByOrder(providers: SavedProvider[], providerOrder: string[]): SavedProvider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  return providerOrder
    .map((id) => byId.get(id))
    .filter((provider): provider is SavedProvider => provider !== undefined)
}

function mergeSavedOrderIntoDisplayOrder(providerOrder: string[], savedOrder: string[]): string[] {
  const savedSet = new Set(savedOrder)
  const queue = [...savedOrder]
  return providerOrder.map((id) => {
    if (!savedSet.has(id)) return id
    return queue.shift() ?? id
  })
}

function appendNewProviderToOrder(providerOrder: string[], providerId: string, existingProviders: SavedProvider[]): string[] {
  const existingProviderIds = new Set(existingProviders.map((provider) => provider.id))
  const lastSavedIndex = providerOrder.reduce(
    (latest, id, index) => existingProviderIds.has(id) ? index : latest,
    -1,
  )
  if (lastSavedIndex !== -1) {
    return [
      ...providerOrder.slice(0, lastSavedIndex + 1),
      providerId,
      ...providerOrder.slice(lastSavedIndex + 1),
    ]
  }

  const firstBuiltInIndex = providerOrder.findIndex((id) => BUILT_IN_PROVIDER_IDS.includes(id as never))
  if (firstBuiltInIndex === -1) return [...providerOrder, providerId]
  return [
    ...providerOrder.slice(0, firstBuiltInIndex),
    providerId,
    ...providerOrder.slice(firstBuiltInIndex),
  ]
}

export class ProviderService {
  private static serverPort = 3456
  private managedSettingsService = new ManagedSettingsService()

  static setServerPort(port: number): void {
    ProviderService.serverPort = port
  }

  static getServerPort(): number {
    return ProviderService.serverPort
  }
  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getCcHahaDir(): string {
    return path.join(this.getConfigDir(), 'cc-haha')
  }

  private getIndexPath(): string {
    return path.join(this.getCcHahaDir(), 'providers.json')
  }

  private async readIndex(): Promise<ProvidersIndex> {
    await ensurePersistentStorageUpgraded()
    return readRecoverableJsonFile({
      filePath: this.getIndexPath(),
      label: 'providers index',
      defaultValue: DEFAULT_INDEX,
      normalize: normalizeProvidersIndex,
    })
  }

  private async writeIndex(index: ProvidersIndex): Promise<void> {
    const filePath = this.getIndexPath()
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })

    const tmpFile = `${filePath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmpFile, JSON.stringify(index, null, 2) + '\n', 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write providers index: ${err}`)
    }
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    return this.managedSettingsService.readSettings()
  }

  async getManagedSettings(): Promise<Record<string, unknown>> {
    return this.readSettings()
  }

  async updateManagedSettings(settings: Record<string, unknown>): Promise<void> {
    await this.managedSettingsService.updateSettings((current) => ({
      settings: Object.assign({}, current, settings),
      result: undefined,
    }))
  }

  // --- CRUD ---

  async listProviders(): Promise<{ providers: SavedProvider[]; activeId: string | null; providerOrder: string[] }> {
    const index = await this.readIndex()
    return {
      providers: index.providers,
      activeId: index.activeId,
      providerOrder: index.providerOrder,
    }
  }

  async getProvider(id: string): Promise<SavedProvider> {
    const index = await this.readIndex()
    const provider = index.providers.find((p) => p.id === id)
    if (!provider) throw ApiError.notFound(`Provider not found: ${id}`)
    return provider
  }

  async addProvider(input: CreateProviderInput): Promise<SavedProvider> {
    const index = await this.readIndex()

    const provider: SavedProvider = {
      id: crypto.randomUUID(),
      presetId: input.presetId,
      name: input.name,
      apiKey: input.apiKey,
      ...(input.authStrategy !== undefined && { authStrategy: input.authStrategy }),
      baseUrl: input.baseUrl,
      apiFormat: input.apiFormat ?? 'anthropic',
      runtimeKind: input.runtimeKind ?? 'anthropic_compatible',
      models: normalizeModelMapping(input.models),
      ...(input.model1mSupport !== undefined && { model1mSupport: input.model1mSupport }),
      ...(input.autoCompactWindow !== undefined && { autoCompactWindow: input.autoCompactWindow }),
      ...(input.modelContextWindows !== undefined && { modelContextWindows: input.modelContextWindows }),
      ...(input.availableModels !== undefined && { availableModels: input.availableModels }),
      toolSearchEnabled: input.toolSearchEnabled ?? true,
      ...(input.notes !== undefined && { notes: input.notes }),
    }

    index.providerOrder = appendNewProviderToOrder(index.providerOrder, provider.id, index.providers)
    index.providers.push(provider)
    await this.writeIndex(index)
    return provider
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<SavedProvider> {
    const index = await this.readIndex()
    const idx = index.providers.findIndex((p) => p.id === id)
    if (idx === -1) throw ApiError.notFound(`Provider not found: ${id}`)

    const existing = index.providers[idx]
    const updated: SavedProvider = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
      ...(input.authStrategy !== undefined && { authStrategy: input.authStrategy }),
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
      ...(input.apiFormat !== undefined && { apiFormat: input.apiFormat }),
      ...(input.runtimeKind !== undefined && { runtimeKind: input.runtimeKind }),
      ...(input.models !== undefined && { models: normalizeModelMapping(input.models) }),
      ...(input.model1mSupport !== undefined && input.model1mSupport !== null && { model1mSupport: input.model1mSupport }),
      ...(typeof input.autoCompactWindow === 'number' && { autoCompactWindow: input.autoCompactWindow }),
      ...(input.modelContextWindows !== undefined && input.modelContextWindows !== null && { modelContextWindows: input.modelContextWindows }),
      ...(input.availableModels !== undefined && input.availableModels !== null && { availableModels: input.availableModels }),
      ...(input.toolSearchEnabled !== undefined && { toolSearchEnabled: input.toolSearchEnabled }),
      ...(input.notes !== undefined && { notes: input.notes }),
    }
    if (input.model1mSupport === null) {
      delete updated.model1mSupport
    }
    if (input.autoCompactWindow === null) {
      delete updated.autoCompactWindow
    }
    if (input.modelContextWindows === null) {
      delete updated.modelContextWindows
    }
    if (input.availableModels === null) {
      delete updated.availableModels
    }

    index.providers[idx] = updated
    await this.writeIndex(index)

    if (index.activeId === id) {
      await this.syncToSettings(updated)
    }

    return updated
  }

  async refreshActiveProviderModels(): Promise<SavedProvider | null> {
    const { providers, activeId } = await this.listProviders()
    if (!activeId) return null
    const activeProvider = providers.find((provider) => provider.id === activeId)
    if (!activeProvider) return null
    return await this.refreshProviderModels(activeProvider)
  }

  async refreshProviderModels(provider: SavedProvider): Promise<SavedProvider | null> {
    if (!shouldAutoRefreshProviderModels(provider)) return provider

    const lastRefreshAt = providerModelRefreshTimestamps.get(provider.id) ?? 0
    const now = Date.now()
    if (now - lastRefreshAt < PROVIDER_MODEL_REFRESH_MIN_INTERVAL_MS) {
      return provider
    }

    const inFlight = providerModelRefreshInFlight.get(provider.id)
    if (inFlight) {
      return await inFlight
    }

    const refresh = (async () => {
      try {
        const { models } = await this.fetchModels({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiFormat: provider.apiFormat,
          authStrategy: provider.authStrategy,
        })
        if (models.length === 0) return provider

        const modelContextWindows = modelContextWindowsFromModels(models)
        const updated = await this.updateProvider(provider.id, {
          models: chooseProviderModelMapping(provider, models),
          availableModels: models,
          modelContextWindows: Object.keys(modelContextWindows).length > 0
            ? modelContextWindows
            : null,
        })
        await this.ensureManagedModelStillAvailable(updated, models)
        return updated
      } catch {
        return provider
      } finally {
        providerModelRefreshTimestamps.set(provider.id, Date.now())
        providerModelRefreshInFlight.delete(provider.id)
      }
    })()

    providerModelRefreshInFlight.set(provider.id, refresh)
    return await refresh
  }

  private async ensureManagedModelStillAvailable(
    provider: SavedProvider,
    models: NormalizedProviderModel[],
  ): Promise<void> {
    const availableIds = new Set(models.map((model) => model.id.trim()).filter(Boolean))
    if (availableIds.size === 0) return

    const settings = await this.getManagedSettings()
    const currentModel = typeof settings.model === 'string' ? settings.model.trim() : ''
    if (!currentModel || availableIds.has(currentModel)) return

    const fallbackModel = provider.models.main.trim() || models[0]?.id.trim()
    if (!fallbackModel) return
    await this.updateManagedSettings({ model: fallbackModel })
  }

  async deleteProvider(id: string): Promise<void> {
    const index = await this.readIndex()
    const idx = index.providers.findIndex((p) => p.id === id)
    if (idx === -1) throw ApiError.notFound(`Provider not found: ${id}`)

    if (index.activeId === id) {
      throw ApiError.conflict('Cannot delete the active provider. Switch to another provider first.')
    }

    index.providers.splice(idx, 1)
    index.providerOrder = index.providerOrder.filter((providerId) => providerId !== id)
    await this.writeIndex(index)
  }

  /**
   * Reorder providers to match the given display id order.
   *
   * New clients send a full display-order permutation including the built-in
   * official providers. Legacy clients may still send only saved provider ids;
   * in that case the saved providers are reordered inside the current display
   * order without moving the built-in official rows.
   */
  async reorderProviders(orderedIds: string[]): Promise<{ providers: SavedProvider[]; providerOrder: string[] }> {
    const index = await this.readIndex()

    const currentSavedIds = savedProviderIds(index.providers)
    const isFullDisplayPermutation = isPermutation(orderedIds, fullProviderOrderIds(index.providers))
    const isLegacySavedPermutation = isPermutation(orderedIds, currentSavedIds)

    if (!isFullDisplayPermutation && !isLegacySavedPermutation) {
      throw ApiError.badRequest('orderedIds must be a permutation of existing provider ids and built-in provider ids')
    }

    index.providerOrder = isFullDisplayPermutation
      ? orderedIds
      : mergeSavedOrderIntoDisplayOrder(index.providerOrder, orderedIds)
    index.providers = sortSavedProvidersByOrder(index.providers, index.providerOrder)
    await this.writeIndex(index)

    return {
      providers: index.providers,
      providerOrder: index.providerOrder,
    }
  }

  // --- Activation ---

  async activateProvider(id: string): Promise<void> {
    const index = await this.readIndex()
    const provider = index.providers.find((p) => p.id === id)
    if (!provider) throw ApiError.notFound(`Provider not found: ${id}`)

    index.activeId = id
    await this.writeIndex(index)

    if (provider.runtimeKind === 'openai_oauth') {
      await this.syncToSettings(provider)
    } else if (provider.presetId === 'official') {
      await this.clearProviderFromSettings()
    } else {
      await this.syncToSettings(provider)
    }
  }

  async activateOfficial(): Promise<void> {
    throw ApiError.notFound('Official providers are disabled in this build')
  }

  // --- Settings sync ---

  private buildManagedEnv(
    provider: SavedProvider,
    options?: { proxyPath?: string },
  ): Record<string, string> {
    return buildProviderManagedEnv(provider, {
      proxyPath: options?.proxyPath,
      serverPort: ProviderService.serverPort,
    })
  }

  async getProviderRuntimeEnv(id: string): Promise<Record<string, string>> {
    const provider = await this.getProvider(id)
    return this.buildManagedEnv(provider, {
      proxyPath: `/proxy/providers/${provider.id}`,
    })
  }

  private async syncToSettings(provider: SavedProvider): Promise<void> {
    await this.managedSettingsService.updateSettings((settings) => {
      const existingEnv = (settings.env as Record<string, string>) || {}
      const cleanedEnv = { ...existingEnv }

      for (const key of getManagedEnvKeys()) {
        delete cleanedEnv[key]
      }

      return {
        settings: {
          ...settings,
          env: {
            ...cleanedEnv,
            ...this.buildManagedEnv(provider),
          },
        },
        result: undefined,
      }
    })
  }

  async syncActiveProviderToSettings(): Promise<void> {
    const index = await this.readIndex()
    if (!index.activeId) return
    const provider = index.providers.find((p) => p.id === index.activeId)
    if (!provider) return
    await this.syncToSettings(provider)
  }

  private async clearProviderFromSettings(): Promise<void> {
    await this.managedSettingsService.updateSettings((settings) => {
      const env = { ...((settings.env as Record<string, string>) || {}) }

      for (const key of getManagedEnvKeys()) {
        delete env[key]
      }

      const nextSettings: Record<string, unknown> = {
        ...settings,
      }

      if (Object.keys(env).length === 0) {
        delete nextSettings.env
      } else {
        nextSettings.env = env
      }

      return {
        settings: nextSettings,
        result: undefined,
      }
    })
  }

  // --- Auth status ---

  /**
   * Check whether any usable auth exists:
   *  1. A cc-haha provider is active → has auth
   *  2. Original ~/.claude/settings.json has ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY → has auth
   *  3. process.env already has ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN → has auth
   *  4. None of the above → needs setup
   */
  async checkAuthStatus(): Promise<{
    hasAuth: boolean
    source: 'cc-haha-provider' | 'openai-oauth' | 'original-settings' | 'env' | 'none'
    activeProvider?: string
  }> {
    // 1. Check cc-haha active provider
    const index = await this.readIndex()
    if (index.activeId) {
      const provider = index.providers.find(p => p.id === index.activeId)
      if (provider) {
        const presetDefaultEnv = getPresetDefaultEnv(provider.presetId)
        const needsProxy = provider.apiFormat != null && provider.apiFormat !== 'anthropic'
        const authEnv = buildProviderAuthEnv(provider, presetDefaultEnv, needsProxy)
        if (provider.models.main.trim() && Object.values(authEnv).some(value => value.length > 0)) {
          return { hasAuth: true, source: 'cc-haha-provider', activeProvider: provider.name }
        }
      }
    }

    return { hasAuth: false, source: 'none' }
  }

  // --- Proxy support ---

  async getProviderForProxy(providerId?: string): Promise<{
    id: string
    name: string
    baseUrl: string
    apiKey: string
    apiFormat: ApiFormat
  } | null> {
    if (providerId) {
      const provider = await this.getProvider(providerId)
      return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiFormat: provider.apiFormat ?? 'anthropic',
      }
    }

    const index = await this.readIndex()
    if (!index.activeId) return null
    const provider = await this.getProvider(index.activeId).catch(() => null)
    if (!provider) return null
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat ?? 'anthropic',
    }
  }

  async getActiveProviderForProxy(): Promise<{
    baseUrl: string
    apiKey: string
    apiFormat: ApiFormat
  } | null> {
    return this.getProviderForProxy()
  }

  // --- Test ---

  async testProvider(
    id: string,
    overrides?: { baseUrl?: string; modelId?: string; apiFormat?: ApiFormat; authStrategy?: ProviderAuthStrategy },
  ): Promise<ProviderTestResult> {
    const provider = await this.getProvider(id)
    const baseUrl = overrides?.baseUrl || provider.baseUrl
    const modelId = overrides?.modelId || provider.models.main
    const apiFormat = overrides?.apiFormat ?? provider.apiFormat ?? 'anthropic'
    const authStrategy = overrides?.authStrategy ?? provider.authStrategy ?? getPresetAuthStrategy(provider.presetId)
    const presetDefaultEnv = getPresetDefaultEnv(provider.presetId)
    const apiKey = provider.apiKey
      || presetDefaultEnv.ANTHROPIC_AUTH_TOKEN
      || presetDefaultEnv.ANTHROPIC_API_KEY
      || (authStrategy === 'dual_dummy' ? 'dummy' : '')

    if (!baseUrl || !apiKey) {
      return { connectivity: { success: false, latencyMs: 0, error: 'Missing baseUrl or apiKey' } }
    }
    return this.testProviderConfig({
      baseUrl,
      apiKey,
      modelId,
      authStrategy,
      apiFormat,
    })
  }

  async testProviderConfig(input: TestProviderInput): Promise<ProviderTestResult> {
    const format: ApiFormat = input.apiFormat ?? 'anthropic'
    const authStrategy = input.authStrategy ?? 'api_key'
    const base = input.baseUrl.replace(/\/+$/, '')
    const modelId = normalizeModelStringForAPI(input.modelId)
    const networkSettings = await loadNetworkSettings()

    // ── Step 1: Basic connectivity ───────────────────────────
    // Directly call the upstream API to verify URL, key, and model.
    const step1 = await this.testConnectivity(base, input.apiKey, modelId, format, authStrategy, networkSettings)

    // If connectivity failed, no point running step 2
    if (!step1.success) {
      return { connectivity: step1 }
    }

    // For native Anthropic format, no proxy pipeline to test
    if (format === 'anthropic') {
      return { connectivity: step1 }
    }

    // ── Step 2: Full proxy pipeline ──────────────────────────
    // Anthropic request → transform → upstream → transform back → validate
    const step2 = await this.testProxyPipeline(base, input.apiKey, modelId, format, networkSettings)

    return { connectivity: step1, proxy: step2 }
  }

  async fetchModels(input: {
    baseUrl: string
    apiKey: string
    apiFormat?: ApiFormat
    authStrategy?: ProviderAuthStrategy
  }): Promise<{ models: NormalizedProviderModel[] }> {
    const base = normalizeBaseUrl(input.baseUrl)
    const format = input.apiFormat ?? 'openai_chat'
    const networkSettings = await loadNetworkSettings()
    const proxyOptions = getProxyFetchOptions({ proxyUrl: getManualNetworkProxyUrl(networkSettings) })
    const headers = format === 'anthropic'
      ? {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...buildAnthropicAuthHeaders(input.apiKey, input.authStrategy ?? 'api_key'),
        }
      : {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
        }

    const urls = getModelListUrls(base, format)
    const failures: string[] = []

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(networkSettings.aiRequestTimeoutMs),
          ...proxyOptions,
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          failures.push(`${url}: HTTP ${response.status}${text ? ` ${text.slice(0, 160)}` : ''}`)
          continue
        }

        const body = await response.json().catch(() => null)
        const rawModels = extractRawModels(body)
        const models = rawModels
          .map((item) => normalizeModelListItem(item))
          .filter((item): item is NormalizedProviderModel => item !== null)

        if (models.length > 0) {
          return { models: dedupeModels(models) }
        }

        failures.push(`${url}: empty model list`)
      } catch (err) {
        failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    throw ApiError.badRequest(`Fetch models failed. Tried ${urls.join(', ')}. ${failures.slice(0, 3).join(' | ')}`)
  }

  /** Step 1: Direct upstream call to verify connectivity, auth, and model. */
  private async testConnectivity(
    base: string,
    apiKey: string,
    modelId: string,
    format: ApiFormat,
    authStrategy: ProviderAuthStrategy,
    networkSettings: NetworkSettings,
  ): Promise<ProviderTestStepResult> {
    const start = Date.now()
    try {
      const { url, headers, body } = buildDirectTestRequest(base, apiKey, modelId, format, authStrategy)
      const proxyOptions = getProxyFetchOptions({ proxyUrl: getManualNetworkProxyUrl(networkSettings) })
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(networkSettings.aiRequestTimeoutMs),
        ...proxyOptions,
      })

      const latencyMs = Date.now() - start
      const resBody = await response.json().catch(() => null) as Record<string, unknown> | null

      if (!response.ok) {
        let error = `HTTP ${response.status}`
        if (resBody?.error && typeof resBody.error === 'object') {
          error = ((resBody.error as Record<string, unknown>).message as string) || error
        }
        return { success: false, latencyMs, error, modelUsed: modelId, httpStatus: response.status }
      }

      // Validate response structure
      const valid = validateResponseBody(resBody, format)
      if (!valid.ok) {
        return { success: false, latencyMs, error: valid.error, modelUsed: modelId, httpStatus: response.status }
      }

      return { success: true, latencyMs, modelUsed: valid.model || modelId, httpStatus: response.status }
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { success: false, latencyMs, error: `Request timed out (${Math.round(networkSettings.aiRequestTimeoutMs / 1000)}s)`, modelUsed: modelId }
      }
      return { success: false, latencyMs, error: err instanceof Error ? err.message : String(err), modelUsed: modelId }
    }
  }

  /** Step 2: Full proxy pipeline — Anthropic → transform → upstream → transform back → validate. */
  private async testProxyPipeline(
    base: string,
    apiKey: string,
    modelId: string,
    format: 'openai_chat' | 'openai_responses',
    networkSettings: NetworkSettings,
  ): Promise<ProviderTestStepResult> {
    const start = Date.now()
    try {
      // Build an Anthropic Messages API request (same shape as what CLI sends)
      const anthropicReq: AnthropicRequest = {
        model: modelId,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      }

      // Transform to OpenAI format
      let upstreamUrl: string
      let transformedBody: unknown
      if (format === 'openai_chat') {
        transformedBody = anthropicToOpenaiChat(anthropicReq)
        upstreamUrl = joinApiPath(base, '/v1/chat/completions')
      } else {
        transformedBody = anthropicToOpenaiResponses(anthropicReq)
        upstreamUrl = joinApiPath(base, '/v1/responses')
      }
      const proxyOptions = getProxyFetchOptions({ proxyUrl: getManualNetworkProxyUrl(networkSettings) })

      // Call upstream with transformed request
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(transformedBody),
        signal: AbortSignal.timeout(networkSettings.aiRequestTimeoutMs),
        ...proxyOptions,
      })

      if (!response.ok) {
        const latencyMs = Date.now() - start
        const errText = await response.text().catch(() => '')
        return { success: false, latencyMs, modelUsed: modelId, httpStatus: response.status,
          error: `Upstream HTTP ${response.status}: ${errText.slice(0, 200)}` }
      }

      // Transform response back to Anthropic format
      const responseBody = await response.json()
      const anthropicRes = format === 'openai_chat'
        ? openaiChatToAnthropic(responseBody, modelId)
        : openaiResponsesToAnthropic(responseBody, modelId)

      const latencyMs = Date.now() - start

      // Validate the final Anthropic response
      if (anthropicRes.type !== 'message' || !Array.isArray(anthropicRes.content)) {
        return { success: false, latencyMs, modelUsed: modelId,
          error: 'Proxy transform produced invalid Anthropic response' }
      }

      return { success: true, latencyMs, modelUsed: anthropicRes.model || modelId, httpStatus: response.status }
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { success: false, latencyMs, error: `Proxy pipeline timed out (${Math.round(networkSettings.aiRequestTimeoutMs / 1000)}s)`, modelUsed: modelId }
      }
      return { success: false, latencyMs, error: err instanceof Error ? err.message : String(err), modelUsed: modelId }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────

function buildDirectTestRequest(
  base: string,
  apiKey: string,
  modelId: string,
  format: ApiFormat,
  authStrategy: ProviderAuthStrategy,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const prompt = 'Say "ok" and nothing else.'

  if (format === 'openai_chat') {
    return {
      url: joinApiPath(base, '/v1/chat/completions'),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: { model: modelId, max_tokens: 16, stream: false, messages: [{ role: 'user', content: prompt }] },
    }
  }
  if (format === 'openai_responses') {
    return {
      url: joinApiPath(base, '/v1/responses'),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: { model: modelId, max_output_tokens: 16, input: [{ type: 'message', role: 'user', content: prompt }] },
    }
  }
  // anthropic
  return {
    url: joinApiPath(base, '/v1/messages'),
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...buildAnthropicAuthHeaders(apiKey, authStrategy),
    },
    body: { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: prompt }] },
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'https:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
      url.protocol = 'http:'
      return url.toString().replace(/\/+$/, '')
    }
  } catch {
    // Keep the original string for validation/error reporting elsewhere.
  }
  return trimmed
}

function baseEndsWithPath(baseUrl: string, suffix: string): boolean {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/+$/, '').toLowerCase()
    return pathname.endsWith(suffix.toLowerCase())
  } catch {
    return baseUrl.replace(/\/+$/, '').toLowerCase().endsWith(suffix.toLowerCase())
  }
}

function joinApiPath(baseUrl: string, apiPath: string): string {
  const base = normalizeBaseUrl(baseUrl)
  if (apiPath.startsWith('/v1/') && baseEndsWithPath(base, '/v1')) {
    return `${base}${apiPath.slice('/v1'.length)}`
  }
  return `${base}${apiPath}`
}

function getModelListUrls(baseUrl: string, format: ApiFormat): string[] {
  const primaryPath = format === 'anthropic' ? '/v1/models' : '/v1/models'
  const candidates = [
    joinApiPath(baseUrl, primaryPath),
    `${normalizeBaseUrl(baseUrl)}/models`,
  ]
  return Array.from(new Set(candidates))
}

function buildAnthropicAuthHeaders(apiKey: string, authStrategy: ProviderAuthStrategy): Record<string, string> {
  switch (authStrategy) {
    case 'api_key':
      return { 'x-api-key': apiKey }
    case 'auth_token':
    case 'auth_token_empty_api_key':
      return { Authorization: `Bearer ${apiKey}` }
    case 'dual_same_token':
      return { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }
    case 'dual_dummy':
      return { 'x-api-key': 'dummy', Authorization: 'Bearer dummy' }
  }
}

function extractRawModels(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []
  const record = body as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  if (Array.isArray(record.model)) return record.model
  return []
}

function dedupeModels(models: NormalizedProviderModel[]): NormalizedProviderModel[] {
  const seen = new Set<string>()
  const result: NormalizedProviderModel[] = []
  for (const model of models) {
    if (seen.has(model.id)) {
      const existing = result.find((item) => item.id === model.id)
      if (existing) {
        const mergedCapabilities = mergeCapabilities(existing.capabilities, model.capabilities)
        if (mergedCapabilities) {
          existing.capabilities = mergedCapabilities
        }
        if (existing.contextWindow === undefined && model.contextWindow !== undefined) {
          existing.contextWindow = model.contextWindow
        }
      }
      continue
    }
    seen.add(model.id)
    result.push(model)
  }
  return result
}

function validateResponseBody(
  body: Record<string, unknown> | null,
  format: ApiFormat,
): { ok: true; model?: string } | { ok: false; error: string } {
  if (!body) return { ok: false, error: 'Empty response — not a valid API endpoint' }
  if (body.error && typeof body.error === 'object') {
    return { ok: false, error: ((body.error as Record<string, unknown>).message as string) || 'Error in response body' }
  }

  if (format === 'openai_chat') {
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      return { ok: false, error: 'Response missing choices — not a valid Chat Completions endpoint' }
    }
    return { ok: true, model: (body.model as string) || undefined }
  }
  if (format === 'openai_responses') {
    if (!Array.isArray(body.output)) {
      return { ok: false, error: 'Response missing output — not a valid Responses API endpoint' }
    }
    return { ok: true, model: (body.model as string) || undefined }
  }
  // anthropic
  if (body.type !== 'message' || !Array.isArray(body.content)) {
    return { ok: false, error: 'Not a valid Anthropic Messages endpoint' }
  }
  return { ok: true, model: (body.model as string) || undefined }
}

function normalizeModelListItem(item: unknown): NormalizedProviderModel | null {
  if (typeof item === 'string') {
    return { id: item, contextWindow: inferContextWindow(item) }
  }
  if (!item || typeof item !== 'object') return null

  const record = item as Record<string, unknown>
  const id = typeof record.id === 'string'
    ? record.id
    : typeof record.name === 'string'
      ? record.name
      : typeof record.model === 'string'
        ? record.model
        : ''
  if (!id.trim()) return null

  const metadata = record.metadata && typeof record.metadata === 'object'
    ? record.metadata as Record<string, unknown>
    : {}
  const limits = record.limits && typeof record.limits === 'object'
    ? record.limits as Record<string, unknown>
    : {}
  const context = record.context && typeof record.context === 'object'
    ? record.context as Record<string, unknown>
    : {}

  const contextCandidates = [
    record.contextWindow,
    record.context_length,
    record.context_window,
    record.maxContextWindow,
    record.max_context_length,
    record.max_context_window,
    record.maxInputTokens,
    record.max_input_tokens,
    record.inputTokenLimit,
    record.input_token_limit,
    metadata.contextWindow,
    metadata.context_length,
    metadata.context_window,
    metadata.maxContextWindow,
    metadata.max_context_length,
    metadata.maxInputTokens,
    metadata.max_input_tokens,
    limits.contextWindow,
    limits.context_length,
    limits.context_window,
    limits.maxContextWindow,
    limits.maxInputTokens,
    limits.max_input_tokens,
    context.length,
    context.window,
    context.contextWindow,
  ]

  const explicit = contextCandidates
    .map((value) => normalizeContextWindowValue(value))
    .find((value): value is number => value !== undefined)

  return {
    id,
    contextWindow: explicit !== undefined ? Math.floor(explicit) : inferContextWindow(id),
    ...capabilitiesProperty(normalizeModelCapabilities(record, id)),
  }
}

function capabilitiesProperty(capabilities: string[] | undefined): Pick<NormalizedProviderModel, 'capabilities'> {
  return capabilities && capabilities.length > 0 ? { capabilities } : {}
}

function mergeCapabilities(
  current: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  const merged: string[] = []
  for (const capability of [...(current ?? []), ...(incoming ?? [])]) {
    if (!merged.includes(capability)) merged.push(capability)
  }
  return merged.length > 0 ? merged : undefined
}

function normalizeModelCapabilities(record: Record<string, unknown>, modelId: string): string[] | undefined {
  const metadata = isRecord(record.metadata) ? record.metadata : {}
  const capabilityValues = [
    record.capabilities,
    record.input_modalities,
    record.inputModalities,
    record.modalities,
    metadata.capabilities,
    metadata.input_modalities,
    metadata.inputModalities,
    metadata.modalities,
  ]

  const capabilities: string[] = []
  for (const value of capabilityValues) {
    collectCapabilities(value, capabilities)
  }

  if (isTruthyFlag(record.supports_reasoning)
    || isTruthyFlag(record.supportsReasoning)
    || isTruthyFlag(record.support_thinking)
    || isTruthyFlag(record.supportThinking)
    || isTruthyFlag(record.support_effort)
    || isTruthyFlag(record.supportEffort)
    || isTruthyFlag(record.support_adaptive_thinking)
    || isTruthyFlag(record.supportAdaptiveThinking)
    || isTruthyFlag(record.reasoning)
    || isTruthyFlag(metadata.supports_reasoning)
    || isTruthyFlag(metadata.supportsReasoning)
    || isTruthyFlag(metadata.support_thinking)
    || isTruthyFlag(metadata.supportThinking)
    || isTruthyFlag(metadata.support_effort)
    || isTruthyFlag(metadata.supportEffort)
    || isTruthyFlag(metadata.support_adaptive_thinking)
    || isTruthyFlag(metadata.supportAdaptiveThinking)
    || isTruthyFlag(metadata.reasoning)) {
    addCapability(capabilities, 'reasoning')
  }
  if (isTruthyFlag(record.supports_image)
    || isTruthyFlag(record.supportsImage)
    || isTruthyFlag(record.support_image)
    || isTruthyFlag(record.supportImage)
    || isTruthyFlag(record.vision)
    || isTruthyFlag(record.image)
    || isTruthyFlag(metadata.supports_image)
    || isTruthyFlag(metadata.supportsImage)
    || isTruthyFlag(metadata.support_image)
    || isTruthyFlag(metadata.supportImage)
    || isTruthyFlag(metadata.vision)
    || isTruthyFlag(metadata.image)) {
    addCapability(capabilities, 'image')
  }

  void modelId
  return orderedCapabilities(capabilities)
}

function orderedCapabilities(capabilities: string[]): string[] | undefined {
  const ordered: string[] = []
  if (capabilities.includes('reasoning')) ordered.push('reasoning')
  if (capabilities.includes('image')) ordered.push('image')
  return ordered.length > 0 ? ordered : undefined
}

function collectCapabilities(value: unknown, target: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCapabilities(item, target)
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (isTruthyFlag(item)) collectCapabilities(key, target)
    }
    return
  }
  if (typeof value !== 'string') return

  const normalized = value.trim().toLowerCase()
  if (!normalized) return
  if (normalized.includes('image') || normalized.includes('vision') || normalized.includes('multimodal')) {
    addCapability(target, 'image')
  }
  if (
    normalized.includes('reason') ||
    normalized.includes('thinking') ||
    normalized.includes('chat') ||
    normalized.includes('code') ||
    normalized.includes('language')
  ) {
    addCapability(target, 'reasoning')
  }
}

function addCapability(target: string[], capability: 'reasoning' | 'image'): void {
  if (!target.includes(capability)) target.push(capability)
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'number') return value > 0
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on', 'supported'].includes(value.trim().toLowerCase())
}

function normalizeContextWindowValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return normalizeContextWindowUnits(value)
  }
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/)
  if (!match) return undefined

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined

  const suffix = match[2]?.toLowerCase()
  if (suffix === 'm') return Math.floor(amount * 1_000_000)
  if (suffix === 'k') return Math.floor(amount * 1_000)
  return normalizeContextWindowUnits(amount)
}

function normalizeContextWindowUnits(value: number): number {
  return value < 10_000 ? Math.floor(value * 1_000) : Math.floor(value)
}

function inferContextWindow(modelId: string): number {
  const id = modelId.toLowerCase()
  if (id.includes('glm-5.2') || id.includes('glm5.2')) return 1_000_000
  if (id.includes('1m') || id.includes('1000k') || id.includes('million')) return 1_000_000
  if (id.includes('glm-5') || id.includes('glm5')) return 128_000
  if (id.includes('qwen') || id.includes('deepseek') || id.includes('kimi')) return 128_000
  if (id.includes('gpt-5') || id.includes('gpt-4.1') || id.includes('gpt-4o')) return 128_000
  return 128_000
}
