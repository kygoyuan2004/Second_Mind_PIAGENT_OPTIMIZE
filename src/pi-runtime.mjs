import { markPublicMessage } from './public-errors.mjs';
import { identifyModelProvider, resolveModelProvider, providerModelReasoningPolicy } from './model-provider-registry.mjs';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { createPiModelAdapter, officialPiModel } from './pi-model-adapter.mjs';

function failure(code, message, status = 400) {
  return markPublicMessage(Object.assign(new Error(message), { code, status }));
}

const bindingByModel = new WeakMap();

export function piCatalog(snapshot) {
  const connections = snapshot.connections || [];
  return (snapshot.models || []).filter((m) => m.enabled !== false).map((source) => {
    const connection = connections.find((c) => c.id === (source.connectionId || source.provider));
    const providerId = connection?.providerId || identifyModelProvider(connection || {});
    let native = { efforts: ['default'], defaultEffort: 'default' };
    try {
      native = providerModelReasoningPolicy(resolveModelProvider({ ...connection, providerId }), source.actualModel);
    } catch { /* Invalid bindings remain visible and fail explicitly when selected. */ }
    const official = officialPiModel(connection, source.actualModel);
    if (official) native = { efforts: ['default', ...getSupportedThinkingLevels(official).filter((level) =>
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(level))], defaultEffort: 'default' };
    const model = {
      ...source,
      label: source.label || source.displayName || source.actualModel,
      shortLabel: source.shortLabel || source.label || source.displayName || source.actualModel,
      value: source.actualModel,
      modalities: official ? [...official.input] : /^qwen(?:3\.8|4)-max(?:$|\[|-)/i.test(source.actualModel) ? ['text', 'image', 'pdf'] : ['text'],
      efforts: native.efforts,
      ...(official ? { effortMapping: source.reasoningMapping?.tiers || {} } : {}),
      defaultEffort: native.efforts.includes(source.defaultEffort) ? source.defaultEffort : native.defaultEffort,
      available: Boolean(connection && (connection.authMode === 'none' || connection.apiKey) && source.available !== false),
      capabilityVerified: false,
    };
    if (connection) bindingByModel.set(model, Object.freeze({
      ...connection, providerId, model: source.actualModel, webSearch: snapshot.webSearch,
      settings: source,
    }));
    return model;
  });
}

export function piBinding(model) {
  const binding = bindingByModel.get(model);
  if (!binding) throw failure('MODEL_CONNECTION_INCOMPLETE', '模型连接未配置，请在配置管理页保存设置。', 409);
  if (!model.available) throw failure('MODEL_CONNECTION_INCOMPLETE', '当前模型不可用。', 409);
  if (binding.providerId === 'deepseek' && new URL(binding.apiBase).hostname !== 'api.deepseek.com') {
    throw failure('SDK_ENDPOINT_INVALID', 'DeepSeek 官方凭据只允许发送到 api.deepseek.com。');
  }
  return binding;
}

export class PiModelRuntime {
  constructor(options = {}) {
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs || 90_000;
  }

  async validateAllEnabled(snapshot, options = {}) {
    const models = piCatalog(snapshot).filter((m) => !options.modelIds || options.modelIds.includes(m.id));
    if (!models.length) throw failure('MODEL_CATALOG_EMPTY', '至少需要一个已启用的模型。');
    const results = [];
    for (const model of models) {
      try {
        const adapter = createPiModelAdapter(piBinding(model), { effort: model.effortMapping?.[model.defaultEffort] || model.defaultEffort, fetch: this.fetch });
        const response = await adapter.stream(adapter.model, { messages: [{
          role: 'user', content: 'Connection check. Reply with OK.', timestamp: Date.now(),
        }] }, { signal: AbortSignal.timeout(this.timeoutMs), maxTokens: 32 }).result();
        if (['error', 'aborted'].includes(response.stopReason)) throw adapter.failure();
        results.push({ modelId: model.id, ok: true, code: 'SDK_CONNECTION_VERIFIED', capability: 'sdk-connection', message: '' });
      } catch (err) {
        results.push({ modelId: model.id, ok: false, code: err.code || 'SDK_VALIDATION_FAILED', message: '模型连接检查失败，请核对地址、模型和凭据。' });
      }
    }
    if (results.some((r) => !r.ok)) throw Object.assign(failure('LLM_VALIDATION_FAILED', '部分模型未通过连接检查。', 422), { results });
    return { ok: true, checked: results.length, results };
  }
}
