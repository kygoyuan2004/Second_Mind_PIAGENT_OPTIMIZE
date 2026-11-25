# Second Mind · Pi Agent 迁移验收

2026 年 11 月 25 日，Pi Agent 版完成 Phase 0–7 验收。上游基线为 `b54ac6ba6379`，本次公开源码取自本地签收版本 `fc5e803358468bdd196c6fc8f424dc9f175df02b`。两个 Pi 运行时依赖均在清单和锁文件中固定为 1.6.0。[原版基线](https://github.com/kygoyuan2004/Second-Mind/commit/b54ac6ba637981b43804874e9fcbecc1d1468718) · [源码对比说明](README.md#comparison)

## 各阶段交付

| 阶段 | 可核查的交付 |
| --- | --- |
| 0 · 独立基线 | 独立检出原版并核对依赖与许可证。生产依赖移除 `@anthropic-ai/claude-agent-sdk`。 |
| 1 · 模型连接 | Pi AI 支持 Anthropic Messages、OpenAI Chat Completions 和显式回环端点。连接检查、凭据绑定与每个任务的配置快照由模型适配层处理。 |
| 2 · 阅读与证据 | 八个只读知识库工具负责检索、列出笔记、查看大纲、按行读取、文本搜索、解析双链、核验引文及查询覆盖率。单次正文读取最多 200 行、32 KiB。稀疏区间树按文件版本合并实际阅读范围。 |
| 3 · 原生多步循环 | Pi Agent Core 的 `runAgentLoop` 将工具结果送回模型继续推理。同轮最多并发 6 个只读调用，子任务共享读取预算。学习回顾可根据服务端覆盖记录追加一次纠正。 |
| 4 · 应用与会话 | 保留 HTTP / SSE、草稿确认写入和各库独立的 `sdk-v1` 状态。对话可跨模型和协议续聊，实时与历史任务均显示有记录的模型用量。 |
| 5 · 打包 | Linux 与 Windows 桌面后端、Docker 文件清单及安装器校验使用 Pi 运行时。源码部署无需专有 Agent 可执行文件。 |
| 6 · 自动化 | 通过下列代码、工具循环、部署入口和生产依赖验证。 |
| 7 · 操作验收 | 操作者用只读知识库和实际模型完成多轮问答、原文核对及用量验收。验收完成后已回收临时服务和挂载。 |

## 迁移签收时的实测结果

Linux x64，Node.js 22.23.2，npm 10.9.8。此表记录签收时的执行结果。公开版本最近一次运行可在本仓库 CI 查看。[持续集成](https://github.com/kygoyuan2004/Second_Mind_PIAGENT_OPTIMIZE/actions/workflows/ci.yml)

| 项目 | 结果 |
| --- | --- |
| `npm run check` | 177 个 JavaScript 文件通过语法检查 |
| `npm test` | 67 个测试文件，439 项测试，435 通过、0 失败、4 项条件跳过 |
| `npm run security:scan` | 发布文件的凭据与私有路径扫描通过 |
| `npm run site:check` | 双语静态站点构建与校验通过 |
| 补充部署测试 | 两个额外文件的 11 项测试全部通过 |
| 生产依赖与启动 | 比对 15,571 个生产依赖文件。按 Docker 文件清单组装应用并启动，`/health/ready` 返回 HTTP 200 |

四项条件跳过覆盖三项 Windows 原生能力及一项需要已安装媒体工具、语音模型和测试媒体的转写集成。此次 Linux 迁移验收覆盖了打包依赖与后端启动。Windows 安装器的实机安装、Docker 守护进程的完整部署属于单独验证范围。

## 怎样复核工具确实跑了多轮？

`test/pi-loop.test.mjs` 用本地流式 HTTP 服务驱动真正的 Pi 循环。测试让模型先读源文件、提交错误的行号、再纠正引文，最后检查流式输出中保留的依据。并发用例在一轮提出 12 个调用，验证并发峰值为 6 且回包顺序与请求一致。其他用例覆盖共享预算、覆盖纠正、跨协议续聊、引用跨分片过滤，以及供应商只在部分轮次报告用量的情况。[工具循环测试](test/pi-loop.test.mjs) · [浏览器用量与引文测试](test/sdk-browser.test.mjs)

运行完整复核前安装 README 要求的 Node.js 版本，并在新的检出目录执行以下命令。

```sh
npm ci
npm run check && npm test && npm run security:scan
node --import ./test/test-environment.mjs --test test/deployment-entrypoints.test.mjs test/require-ci-success.test.mjs
npm run site:check
```

## 公开演示库试跑

按首页步骤从新的检出目录复制三篇公开笔记，实际启动网页，在管理页添加、验证并保存本机 OpenAI Chat Completions 连接。模拟模型依次请求检索和枚举、按行读取、核验引文，再返回回答。浏览器显示 4 次模型调用及模拟服务报告的用量，点击引用后定位到 `Learning/RAG.md` 第 7 行。[首页截图](docs/assets/second-mind-pi-qa.png)

## 首次公开 CI 的修正

跨平台测试复现了连续追问时的任务名额竞态。现在任务完成审计和清理、释放名额后，才对外公布完成状态。新增回归用例主动延迟审计，验证上一轮完成后同一对话可以立即追问。Windows 测试启动器使用独立的短临时路径，避免较长的仓库名让 Git 的测试仓库路径超出系统限制。[生命周期回归](test/sdk-lifecycle.test.mjs) · [本仓库 CI](https://github.com/kygoyuan2004/Second_Mind_PIAGENT_OPTIMIZE/actions/workflows/ci.yml)

修正后在 Linux 上复跑 440 项测试，436 通过、0 失败、4 项条件跳过。11 项补充部署检查、源码安全扫描、站点检查及公开演示库问答也已通过。
