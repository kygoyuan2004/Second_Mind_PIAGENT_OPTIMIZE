# Security boundaries

Second Mind is a self-hosted application for one trusted administrator. Use a controlled host and private network, or configure TLS and access control before exposing it. An application permission boundary is not an operating-system sandbox.

## Authentication and credentials

Knowledge and administration APIs require signed administrator sessions. Cookies are HttpOnly and SameSite=Strict; use `SECURE_COOKIE=true` behind HTTPS. State-changing API calls require request-verification headers and reject conflicting origins. Sensitive configuration mutations reauthenticate the password and enforce revision checks. Throttling and validation receipts are process-local.

Provider keys stay in private server configuration. GET responses expose configured status only. Endpoint/protocol changes require replacing or clearing the key. The browser removes entered keys after staging and stores no provider credentials in localStorage, URLs, or cookies. A session cookie is an authentication credential and must also remain private.

The model adapter pins public HTTPS destinations after DNS validation and rejects redirects. Administrators may configure loopback HTTP explicitly for local inference. Model keys are attached to the selected endpoint in memory. Web tools acquire separately managed credentials.

## Vaults and tools

Private state must stay outside indexed Vault roots. Registration validates canonical roots, stable IDs, overlap, path traversal, and symbolic links. Each knowledge base owns its index, task IDs, conversation IDs, drafts, SDK state, recovery copies and audit files. Cross-base identifiers do not authorize access.

Pi can call server-defined read-only tools inside the selected Vault. The path policy checks hidden entries, configured exclusions, symbolic links and reparse points. Deep mode can create at most two read-only child sessions. Their tools have the same path restrictions. Administrators with host access can read private state.

## Writes and migration

Generation writes drafts outside the Vault. Confirmation rechecks ownership, expiration, allowed destination, symlinks, concurrent edits, and attachments. Replacing a note creates a private preimage recovery copy. A failed audit append after a successful commit must not trigger a blind retry.

Old conversation and draft files remain untouched during additive SDK migration. Imported state and receipts are separate. Legacy draft saving uses only the old write compatibility path, never the old executor. Backups contain credentials and private content; protect permissions and verify restoration independently.

## External services

Models receive user content and tool-returned note excerpts. Remote embedding builds may transmit all eligible text in the selected Vault. Web queries and extracted pages go to their configured providers. Learning reviews skip networking. Speech models may download public weights on first use, and URL video imports contact source hosts. Read [data flow](data-flow.md) before enabling services.

Model output is untrusted. The UI sanitizes Markdown and requires review before writing. Correct citation formatting and factual accuracy are not guaranteed by SDK compatibility.

## Containers and release

The image runs without root by default, drops capabilities, uses a read-only root filesystem, and persists application state separately from Vault mounts. Media and SDK temporary state need writable private storage. Match mounted directory ownership to the container UID/GID. Docker Desktop file ACLs differ from native Linux; see platform guidance.

The Docker context is an explicit runtime allowlist. Historical code, test credentials, private backups, acceptance logs, and real API keys do not belong in images or Pages. Before publication, scan the working tree, staged diff, outgoing history, built site, image metadata/layers, and screenshot OCR/metadata. A clean scan is evidence for the scanned artifacts, not proof against every possible leak.

See [deployment](deployment.md), [configuration](configuration.md), and the dated [validation scope](claude-sdk-migration.md).
