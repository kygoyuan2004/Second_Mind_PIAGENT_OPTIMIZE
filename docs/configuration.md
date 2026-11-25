# Configuration

Use `admin-config.html?knowledgeBaseId=default` after signing in. The query parameter selects the knowledge base for index operations and return links. Model connections and branding are managed centrally; each Vault has separate runtime state and index activation.

## Startup

Minimum: `VAULT_PATH`, a private `DATA_DIR`, `ADMIN_PASSWORD_FILE`, and `SESSION_SECRET_FILE`. Installer-generated files and Docker secrets avoid putting values in command arguments. `HOST`, `PORT`, `SECURE_COOKIE`, and `KNOWLEDGE_BASE_ALLOWED_ROOTS` control the listener and mount boundary. See the reviewed examples and [deployment guide](deployment.md).

The server loads the pinned Pi runtime from its application dependencies. Keep private application state outside the Vault.

## Models and credentials

The page retains provider, API Base, authentication, model ID, display name, default model, effort, key replacement/preservation/clear, connection checks, save/reload, and branding. It supports up to three enabled models.

Select Anthropic Messages or OpenAI Chat Completions to match the provider endpoint. Custom connections also accept explicit loopback HTTP addresses for local inference. Public endpoints require validated HTTPS. The application retains Bailian context suffixes in its model catalogue and removes them from the wire identifier.

For a local tool-capable model, select Custom, enter its loopback API base, and select the matching protocol and authentication method. For hosted models, use the endpoint and model ID supplied by the provider. Test the connection before saving. A local endpoint in Docker refers to the application container’s loopback interface.

Qwen 3.8 Max exposes its original Low, Medium and XHigh levels. DeepSeek exposes Low, High and Max. Unknown capabilities use model default. Explicit administrator effort mappings are reported when used. An accepted request proves transport compatibility, not a measured improvement in reasoning quality.

DeepSeek's [Anthropic compatibility document](https://api-docs.deepseek.com/guides/anthropic_api/) describes provider-side model alias routing and ignored compatibility fields. In particular, its documented routing for `deepseek-v4-pro` can change behind the same API identifier. The application records the configured/wire identifier and does not claim to establish the underlying model revision. [Effort support](https://api-docs.deepseek.com/guides/thinking_mode/) is limited to native supported values; token-budget hints are not advertised as enforced DeepSeek reasoning budgets.

## Save and validation

Connection checks send a short prompt through each enabled model in sequence with a 90-second timeout per model. A live provider may charge for this request. A successful check produces a short-lived, one-use validation receipt bound to the administrator and configuration revision. Saving commits that candidate. The browser clears entered keys after submission.

Each running task keeps its connection snapshot. A subsequent turn can use a different configured model and effort with the same stored conversation.

## Embedding

`disabled`, `openai-compatible`, and `dashscope` providers are retained. Desired configuration is shared, but each knowledge base builds and activates its own index. The prior active index remains usable during build, cancellation, or failure. A fresh SDK index needs an explicit build; old Pi vectors are not silently relabeled as the new index.

Building may send every eligible text chunk in the selected Vault. The administrator page supports credential checks, dimension detection, progress, cancellation and activation. Without a usable semantic index, keyword search remains available and hybrid retrieval reports its lexical route. The original tokenizer, chunking, cache and ranking implementation is used. Embedding timeout/batch defaults remain 12 seconds / 20 items; reranking keeps the original 20-second timeout.

## Web, speech and video

Web search defaults to disabled. Native web tools use the configured Bailian or Tavily client and SafeWebReader. Web credentials are managed separately from model credentials. Personal learning reviews use local knowledge tools exclusively.

The Docker image supplies Python, faster-whisper, yt-dlp, ffmpeg and ffprobe. `KNOWLEDGE_SPEECH_MODEL` can point to a predownloaded model directory; the default small model needs network access on first use. Media HOME/cache is private per Vault. Native source deployments can override `KNOWLEDGE_SPEECH_PYTHON`, `KNOWLEDGE_VIDEO_PYTHON`, `KNOWLEDGE_VIDEO_YT_DLP`, and relevant ffmpeg paths.

Task budgets are defined in `src/original/task-modes.mjs` and `src/original/learning-review.mjs`. The executor applies them to the Pi tool loop.
