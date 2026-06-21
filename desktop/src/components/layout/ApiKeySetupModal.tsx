import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'
import { Input } from '../shared/Input'
import { providersApi } from '../../api/providers'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'

type ApiKeySetupModalProps = {
  enabled: boolean
}

type ModelListItem = {
  id: string
  contextWindow?: number
  capabilities?: string[]
}

const DEFAULT_BASE_URL = 'https://ai.xkxkbbk.cloud'

export function ApiKeySetupModal({ enabled }: ApiKeySetupModalProps) {
  const locale = useSettingsStore((s) => s.locale)
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [apiKey, setApiKey] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const text = useMemo(() => getSetupText(locale), [locale])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const checkSetup = async () => {
      setChecking(true)
      try {
        const [authStatus, list] = await Promise.all([
          providersApi.authStatus(),
          providersApi.list(),
        ])
        if (cancelled) return
        const activeProvider = list.activeId
          ? list.providers.find((provider) => provider.id === list.activeId)
          : null
        const needsSetup =
          !authStatus.hasAuth ||
          !activeProvider ||
          !activeProvider.models.main.trim()
        setOpen(needsSetup)
      } catch {
        if (!cancelled) setOpen(true)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }

    void checkSetup()

    return () => {
      cancelled = true
    }
  }, [enabled])

  const canSubmit = apiKey.trim().length > 0 && baseUrl.trim().length > 0 && !saving

  const handleFetchAndSave = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
      const result = await providersApi.fetchModels({
        baseUrl: normalizedBaseUrl,
        apiKey: apiKey.trim(),
        apiFormat: 'anthropic',
        authStrategy: 'api_key',
      })
      const models = result.models
      const firstModel = pickPreferredModel(models)
      if (!firstModel) {
        setError(text.noModels)
        return
      }
      await saveProvider(firstModel.id, models)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleManualSave = async () => {
    const modelId = manualModel.trim()
    if (!canSubmit || !modelId) return
    setSaving(true)
    setError(null)
    try {
      await saveProvider(modelId, [{ id: modelId, contextWindow: inferContextWindow(modelId) }])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const saveProvider = async (modelId: string, models: ModelListItem[]) => {
    const modelContextWindows = buildContextWindows(models)
    const contextWindow = modelContextWindows[modelId] ?? inferContextWindow(modelId)
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

    const provider = await useProviderStore.getState().createProvider({
      presetId: 'local-openai',
      name: 'Local API',
      apiKey: apiKey.trim(),
      baseUrl: normalizedBaseUrl,
      apiFormat: 'anthropic',
      authStrategy: 'api_key',
      models: {
        main: modelId,
        haiku: modelId,
        sonnet: modelId,
        opus: modelId,
      },
      autoCompactWindow: contextWindow,
      modelContextWindows,
      availableModels: models,
      toolSearchEnabled: false,
    })

    await providersApi.activate(provider.id)
    await useProviderStore.getState().fetchProviders()
    const settings = useSettingsStore.getState()
    await settings.setModel(modelId)
    await settings.fetchAll()
    setOpen(false)
  }

  if (!enabled || checking) return null

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={text.title}
      width={460}
      footer={(
        <Button
          type="button"
          loading={saving}
          disabled={!canSubmit}
          onClick={handleFetchAndSave}
        >
          {saving ? text.saving : text.fetchAndSave}
        </Button>
      )}
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
          {text.description}
        </p>
        <Input
          label={text.baseUrl}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={DEFAULT_BASE_URL}
          required
        />
        <Input
          label={text.apiKey}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={text.apiKeyPlaceholder}
          type="password"
          required
          autoFocus
        />
        {error ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 p-3 text-xs leading-5 text-[var(--color-error)]">
            {error}
          </div>
        ) : null}
        {error ? (
          <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
            <Input
              label={text.manualModel}
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              placeholder="glm-5.2"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={saving}
              disabled={!manualModel.trim() || !canSubmit}
              onClick={handleManualSave}
            >
              {text.saveManual}
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

function getSetupText(locale: string) {
  const isZh = locale.startsWith('zh')
  return isZh
    ? {
        title: '\u914d\u7f6e\u767d\u767d API',
        description: '\u8bf7\u8f93\u5165\u4f60\u7684 API \u5bc6\u94a5\u3002\u5e94\u7528\u4f1a\u81ea\u52a8\u4ece\u63a5\u53e3\u83b7\u53d6\u6a21\u578b\u5e76\u5b8c\u6210\u914d\u7f6e\u3002',
        baseUrl: '\u63a5\u53e3\u5730\u5740',
        apiKey: '\u5bc6\u94a5',
        apiKeyPlaceholder: '\u8f93\u5165 sk-...',
        fetchAndSave: '\u83b7\u53d6\u6a21\u578b\u5e76\u5f00\u59cb\u4f7f\u7528',
        saving: '\u6b63\u5728\u914d\u7f6e',
        noModels: '\u63a5\u53e3\u5df2\u8fde\u63a5\uff0c\u4f46\u6ca1\u6709\u8fd4\u56de\u53ef\u7528\u6a21\u578b\u3002',
        manualModel: '\u624b\u52a8\u6a21\u578b ID',
        saveManual: '\u4f7f\u7528\u6b64\u6a21\u578b\u4fdd\u5b58',
      }
    : {
        title: 'Configure Baibai API',
        description: 'Enter your API key. The app will fetch models from the endpoint and finish setup automatically.',
        baseUrl: 'Base URL',
        apiKey: 'API Key',
        apiKeyPlaceholder: 'Enter sk-...',
        fetchAndSave: 'Fetch Models and Start',
        saving: 'Configuring',
        noModels: 'The endpoint responded, but no models were returned.',
        manualModel: 'Manual Model ID',
        saveManual: 'Save With This Model',
      }
}

function pickPreferredModel(models: ModelListItem[]): ModelListItem | null {
  if (models.length === 0) return null
  return models.find((model) => model.id.toLowerCase() === 'glm-5.2')
    ?? models.find((model) => model.id.toLowerCase().includes('glm-5.2'))
    ?? models[0]!
}

function buildContextWindows(models: ModelListItem[]): Record<string, number> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      model.contextWindow ?? inferContextWindow(model.id),
    ]),
  )
}

function inferContextWindow(modelId: string): number {
  const id = modelId.toLowerCase()
  if (id.includes('glm-5.2') || id.includes('glm5.2')) return 1_000_000
  if (id.includes('1m') || id.includes('1000k') || id.includes('million')) return 1_000_000
  return 128_000
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
    return trimmed
  }
  return trimmed
}
