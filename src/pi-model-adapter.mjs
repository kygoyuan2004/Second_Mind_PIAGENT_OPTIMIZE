import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { stream as anthropicStream, streamSimple as anthropicSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as openaiStream, streamSimple as openaiSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { createPinnedModelFetch } from './model-transport.mjs';
import { resolveModelProvider, providerAuthHeaders, providerModelCapabilities,
  providerModelOutputLimit, providerReasoningFields } from './model-provider-registry.mjs';

const errors = {
  400: ['SDK_PARAMETERS_REJECTED', '供应商拒绝了模型或请求参数。'],
  401: ['SDK_AUTH_FAILED', '模型鉴权失败，请更新凭据。'],
  402: ['SDK_PAYMENT_REQUIRED', '供应商账户余额不足或需要开通服务。'],
  403: ['SDK_PERMISSION_DENIED', '供应商拒绝访问。'],
  404: ['SDK_MODEL_NOT_FOUND', '模型或接口不存在。'],
  422: ['SDK_PARAMETERS_REJECTED', '供应商不支持当前参数。'],
  429: ['SDK_RATE_LIMITED', '模型请求达到限额。'],
};

// Bind built-in capabilities only to the corresponding official API origin.
export function officialPiModel(connection, modelId) {
  if (!connection?.apiBase || !URL.canParse(connection.apiBase)) return;
  const origin = new URL(connection.apiBase).origin;
  let catalog;
  if (origin === 'https://api.openai.com' && connection.protocol === 'openai-chat-completions') catalog = OPENAI_MODELS;
  if (origin === 'https://api.anthropic.com' && connection.protocol === 'anthropic-messages') catalog = ANTHROPIC_MODELS;
  if (catalog && Object.hasOwn(catalog, modelId)) return catalog[modelId];
}

export function createPiModelAdapter(binding, { fetch = createPinnedModelFetch(), effort = 'default', documents = new Map() } = {}) {
  const provider = resolveModelProvider({ ...binding, authMode: undefined });
  const anthropic = provider.protocol === 'anthropic-messages';
  const api = anthropic ? 'anthropic-messages' : 'openai-completions';
  const official = officialPiModel(binding, binding.model);
  const wireModel = provider.id === 'bailian' ? binding.model.replace(/\[(?:1m|200k)\]$/iu, '') : binding.model;
  const contextWindow = /\[1m\]$/iu.test(binding.model) ? 1_000_000 : /\[200k\]$/iu.test(binding.model)
    ? 200_000 : official?.contextWindow || binding.settings?.contextWindow || 128_000;
  const model = {
    ...official, id: binding.model, name: binding.model, provider: official?.provider || provider.id, api,
    baseUrl: provider.endpoint.slice(0, -(anthropic ? '/v1/messages' : '/chat/completions').length),
    input: official?.input || ['text', 'image'], reasoning: official?.reasoning ?? true, contextWindow,
    maxTokens: Math.min(binding.settings?.maxOutputTokens || 16384, official?.maxTokens || providerModelOutputLimit(provider, binding.model)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: official && anthropic ? official.compat : anthropic ? { supportsEagerToolInputStreaming: false, supportsStrictTools: false }
      : { supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: false,
          maxTokensField: new URL(provider.endpoint).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens', requiresThinkingAsText: false,
          requiresReasoningContentOnAssistantMessages: providerModelCapabilities(provider, binding.model).requiresCompleteAssistantReplay },
  };
  let status;
  const authHeaders = providerAuthHeaders({ ...provider, authMode: binding.authMode || provider.authMode }, binding.apiKey);
  const pinned = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (anthropic && target.search === '?beta=true') target.search = '';
    if (target.href !== provider.endpoint) throw new Error('模型请求地址不匹配。');
    // Canonical loopback avoids a second hostname lookup for local inference.
    if (target.protocol === 'http:' && target.hostname === 'localhost') target.hostname = '127.0.0.1';
    const headers = { 'content-type': 'application/json', ...Object.fromEntries(new Headers(authHeaders)) };
    if (anthropic) headers['anthropic-version'] = '2023-06-01';
    if (official && anthropic) {
      const beta = new Headers(init.headers).get('anthropic-beta');
      if (beta) headers['anthropic-beta'] = beta;
    }
    const response = await fetch(target.href, { ...init, headers, redirect: 'error' });
    status = response.status;
    return response;
  };
  const providerStream = official ? (anthropic ? anthropicSimple : openaiSimple) : (anthropic ? anthropicStream : openaiStream);
  const stream = (selected, context, options = {}) => providerStream(selected, context, {
    ...options, env: {}, reasoning: official && effort !== 'default' ? effort : undefined, apiKey: 'managed-in-process', fetch: pinned, maxRetries: 0,
    maxTokens: options.maxTokens || model.maxTokens, cacheRetention: 'none',
    onPayload(payload) {
      payload.model = wireModel;
      if (!official) {
        for (const field of ['reasoning_effort', 'thinking', 'enable_thinking', 'output_config']) delete payload[field];
        Object.assign(payload, providerReasoningFields(provider, effort));
      }
      for (const message of payload.messages) {
        if (message.role !== 'user' || !Array.isArray(message.content)) continue;
        message.content = message.content.map((block) => {
          const document = block.type === 'text' && documents.get(block.text);
          if (!document) return block;
          return anthropic ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.data } }
            : { type: 'file', file: { filename: document.name, file_data: 'data:application/pdf;base64,' + document.data } };
        });
      }
      return payload;
    },
  });
  return { model, stream, failure() {
    const [code, message] = errors[status] || ['SDK_EXECUTION_FAILED', '模型请求未能完成，请检查连接。'];
    return Object.assign(new Error(message), { code });
  } };
}
