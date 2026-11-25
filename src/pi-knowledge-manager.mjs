import { executePiTask } from './pi-agent-executor.mjs';
import { isInventoryRequest } from './original/knowledge-inventory.mjs';

import { KnowledgeAgentManager } from './original/knowledge-agent.mjs';
import { piCatalog, piBinding } from './pi-runtime.mjs';
import { markPublicMessage } from './public-errors.mjs';

function error(code, message, status = 409) {
  return markPublicMessage(Object.assign(new Error(message), { code, status }));
}

function scrub(value, root) {
  if (typeof value === 'string') return value.replaceAll(root, '[知识库]')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[凭据已隐藏]');
  if (Array.isArray(value)) return value.map((v) => scrub(v, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, root)]));
  return value;
}

export class PiKnowledgeManager extends KnowledgeAgentManager {
  constructor(config, options) {
    super({ ...options, hybridSearchEnabled: true, deepTasksEnabled: true, subagentsEnabled: true,
      modelCatalog: piCatalog(options.runtimeConfig.runtimeSnapshot()),
      conversationFile: config.conversationFile,
      timeZone: config.timezone,
    });
    this.config = config;
    this.runtimeConfig = options.runtimeConfig;
    this.transportFetch = options.piFetch;
    this.webFactory = options.webFactory;
    this.running = new Set();
  }

  async resolveModelCatalog() {
    await this.runtimeConfig.refresh();
    const snapshot = this.runtimeConfig.runtimeSnapshot();
    this.modelCatalog = piCatalog(snapshot);
    this.defaultModelId = snapshot.defaultModelId;
    return this.modelCatalog;
  }

  async createTask(userId, body) {
    if (['tools', 'allowedTools', 'disallowedTools', 'mcpServers', 'permissionMode', 'systemPrompt', 'env', 'settings', 'agents', 'sdkSessionId', 'resume', 'maxTurns', 'cwd'].some((key) => Object.hasOwn(body, key))) {
      throw error('CLIENT_AGENT_OPTIONS_DENIED', '执行权限、工具和 SDK 状态由服务器管理。', 400);
    }
    if (isInventoryRequest(body)) return super.createTask(userId, body);
    await this.runtimeConfig.refresh();
    const snapshot = this.runtimeConfig.runtimeSnapshot();
    if (body.modelCatalogRevision && body.modelCatalogRevision !== snapshot.modelCatalogRevision) {
      throw error('MODEL_CATALOG_CHANGED', '模型配置已改变，请刷新页面后重新选择模型。');
    }
    if (!piCatalog(snapshot).some((m) => m.available)) {
      throw error('LLM_NOT_CONFIGURED', '请先在配置管理页添加并检查一个可用模型。', 503);
    }
    return super.createTask(userId, body);
  }

  validateTaskModel(userId, body, model) {
    const binding = piBinding(model);
    if (body.webSearch && !binding.webSearch?.enabled) throw error('WEB_SEARCH_NOT_CONFIGURED', '请先在配置页启用并验证联网搜索。');
  }

  async publicStatus(userId) {
    await this.resolveModelCatalog();
    const value = await super.publicStatus(userId);
    const snapshot = this.runtimeConfig.runtimeSnapshot();
    return { ...value, rootLabel: this.config.vaultLabel, appName: snapshot.branding?.appName || 'Second Mind',
      defaultModelId: snapshot.defaultModelId || null,
      llm: { configured: this.modelCatalog.some((m) => m.available), model: this.modelCatalog.find((m) => m.id === snapshot.defaultModelId)?.actualModel || null },
      embedding: { enabled: this.index?.status?.().semanticAvailable === true },
      modelCatalogRevision: snapshot.modelCatalogRevision,
      executor: 'pi-agent-sdk', sdkVersion: '1.6.0',
    };
  }

  publicConversation(conversation) {
    try { return super.publicConversation(conversation); }
    catch {
      return { id: conversation.id, kind: conversation.kind, title: conversation.title,
        model: conversation.modelId, effort: conversation.effortId, webSearch: Boolean(conversation.webSearch),
        taskMode: conversation.taskModeId || 'normal', createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt, activeTask: null, modelUnavailable: true };
    }
  }

  publicTask(task) {
    return { id: task.id, taskId: task.id, conversationId: task.conversationId, kind: task.kind,
      status: task.status, model: task.model.id, effort: task.effort.id,
      createdAt: task.createdAt, updatedAt: task.updatedAt, draftId: task.draftId,
      taskMode: task.taskMode.id, assistantText: task.assistantText };
  }

  runTask(task, conversation) {
    const operation = super.runTask(task, conversation);
    this.running.add(operation);
    operation.then(() => this.running.delete(operation), () => this.running.delete(operation));
    return operation;
  }

  executeTask(task, conversation) {
    return executePiTask(this, task, conversation, piBinding(task.model));
  }

  emit(task, type, data) {
    // Keep text/citations intact; source paths inside activity messages are relative.
    return super.emit(task, type, ['diagnostic', 'task_error', 'warning', 'activity'].includes(type)
      ? scrub(data, task.root) : data);
  }

  async close() {
    super.close();
    await Promise.allSettled([...this.running, ...this.inventoryRuns]);
    await this.persistQueue;
    await this.index?.close?.();
  }
}
