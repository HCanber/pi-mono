# Azure Foundry: Design Decisions

## Conversation Memory

- The old `packages/ai` Azure Foundry OAuth provider attempt was exploratory only and has been removed. It was not needed by anything else.
- Foundry endpoint setup must not use generic `/login azure-foundry`. The generic OAuth login path persists `{ type: "oauth", ...credentials }` under a static provider id, but Foundry needs `{ type: "azure-foundry", endpoint }` under a user-selected dynamic endpoint key.
- Foundry Bearer tokens must be applied per request. Do not store an `Authorization` header in `model.headers` at model creation time because Azure AD tokens are short-lived and acquired on demand.

## Why Dedicated Provider (Not Transparent Proxy)?

Two architectures were evaluated:

### Option A: Transparent proxy (`isGlobalProxy`)

`modifyModels()` rewrites ALL models' `baseUrl` to the Foundry endpoint. Models keep their original `provider` field (`"anthropic"`, `"openai"`, etc.).

Problems:
- **Auth chain mismatch**: Credential stored under `"azure-foundry"`, but `hasConfiguredAuth()`, `getApiKeyAndHeaders()`, `isUsingOAuth()`, and `completeProviderAuthentication()` all key lookups on `model.provider` (e.g., `"anthropic"`). Requires `isGlobalProxy` flag and fallbacks in 4+ methods.
- **Model availability lies**: Shows models as available that aren't deployed on the user's Foundry resource. Not all models are deployed, and each user has a different set.
- **Google SDK dual-header**: Google GenAI SDK sends `x-goog-api-key` alongside the injected `Authorization: Bearer` header. Foundry ignores it, but it's a quirk.
- **Direct API key conflict**: If a user has both a direct Anthropic key and Foundry active, requests carry both `x-api-key` (direct) and `Authorization: Bearer` (Foundry) to the Foundry endpoint.
- **Deployment name mismatch**: Foundry deployments can have custom names (e.g., `claude-opus-4-7` deployed as `my-claude`). A transparent proxy can't handle this.

### Option B: Dedicated provider (GitHub Copilot pattern) — **chosen**

Models have `provider: "<endpoint-key>"` (e.g., `"azure-foundry-1"`) with varying `api` fields. User curates their own model catalog. Each Foundry endpoint is a separate provider.

Benefits:
- **Auth chain works unmodified**: `hasConfiguredAuth("azure-foundry-1")`, `getApiKey("azure-foundry-1")` all resolve correctly — the credential key matches the model's provider field.
- **No lies**: Only models the user has actually deployed appear in the selector.
- **No conflicts**: Foundry models live in separate namespaces from direct provider models and from each other.
- **Custom deployment names**: The user maps their deployment name to the source model's metadata.
- **Multi-endpoint**: Different Foundry resources (regions, tenants, teams) coexist naturally as separate providers.

## Multiple Endpoints (Dynamic Provider IDs)

### Why not a single `"azure-foundry"` provider?

A single provider works for GitHub Copilot because there's one endpoint (determined by org type). Foundry is different:

- Users may have separate Foundry resources for different regions, tenants, or cost centers
- Each resource has its own endpoint URL and may have different models deployed
- The same model might be deployed on multiple endpoints with different names

Dynamic provider IDs (`azure-foundry-1`, `azure-foundry-2`, etc.) solve this naturally:
- Each endpoint is a separate credential in `auth.json`
- Models reference their endpoint via `provider: "azure-foundry-1"`
- `hasConfiguredAuth()`, `getApiKey()`, `getApiKeyAndHeaders()` all do exact key lookups — no special-casing needed
- Endpoint-specific flows can filter `model.provider === endpointKey` to find models for that endpoint

### Why store endpoint config in `auth.json`?

The endpoint URL is a credential-adjacent config: it defines *where* to authenticate and send requests. Alternatives considered:

1. **`settings.json` only**: Endpoint URL would be in SettingsManager, but `AuthStorage.getApiKey()` needs the endpoint to know which Foundry resource to target. Would require cross-referencing between two stores.

2. **OAuth credential with endpoint field**: Store `{ type: "oauth", endpoint, access, refresh, expires }`. Works, but Azure AD tokens are short-lived (1h) and acquired on-demand via `DefaultAzureCredential`. Storing them is pointless — they'll always be expired on next startup. The `refreshToken()` call just acquires a new one anyway.

3. **New credential type** (chosen): `{ type: "azure-foundry", endpoint }`. Minimal storage — just the endpoint URL. Token acquired on-demand by `AuthStorage.getApiKey()` via `DefaultAzureCredential`. Benefits:
   - No stale token persistence
   - `hasAuth()` works (credential exists → configured)
   - `getApiKey()` acquires fresh token each time (Azure SDK caches internally)
   - Clean separation: endpoint config is persistent, tokens are ephemeral

### Why not generic `/login azure-foundry`?

`AuthStorage.login(providerId, callbacks)` always calls a static OAuth provider and stores the result under that provider id:

```ts
const credentials = await provider.login(callbacks);
this.set(providerId, { type: "oauth", ...credentials });
```

That is wrong for Foundry because the selected provider id on a Foundry model is a dynamic endpoint key such as `azure-foundry-1`, not the static OAuth provider id `azure-foundry`. Reusing `/login` would either store credentials under the wrong key or require a special-case branch in the generic login flow. The dedicated `/foundry add-endpoint` command can store the correct credential shape directly:

```json
{ "type": "azure-foundry", "endpoint": "https://myresource.services.ai.azure.com" }
```

`completeProviderAuthentication()` is also the wrong hook for Foundry. It receives a static provider id from the login flow; Foundry endpoint setup produces a user-named endpoint key.

### `modifyModels()` loop — why skip it?

The existing `modifyModels()` loop in `ModelRegistry.loadModels()` (~L381) iterates registered OAuth providers by exact ID:

```ts
for (const oauthProvider of this.authStorage.getOAuthProviders()) {
    const cred = this.authStorage.get(oauthProvider.id);
    if (cred?.type === "oauth" && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
    }
}
```

This doesn't work for dynamic IDs (`azure-foundry-1`, `azure-foundry-2`) because:
- `getOAuthProviders()` returns the statically registered `azureFoundryOAuthProvider` with `id: "azure-foundry"`
- `this.authStorage.get("azure-foundry")` returns nothing — credentials are under `"azure-foundry-1"` etc.

Rather than adding prefix matching or changing the `modifyModels` signature to accept credential IDs, Foundry models are injected directly in `loadModels()` with endpoint `baseUrl` and request auth config. This keeps the OAuth loop untouched and avoids coupling the general mechanism to Foundry's multi-endpoint design.

## `authHeader` Flag — Applicable Per Request

The existing `authHeader` flag in `providerRequestConfigs` takes the resolved `apiKey` for a provider and promotes it to an `Authorization: Bearer` header.

Under the dedicated provider approach, `authStorage.getApiKey("azure-foundry-1")` returns the current Azure AD Bearer token. `getApiKeyAndHeaders()` should apply that token per request via `authHeader`, so the `Authorization` header is always built from a fresh token.

Do not inject `Authorization` into `model.headers` while creating Foundry models. That would freeze a token into the model registry and let it expire.

## Model Catalog Source

**Built-in model registry** (`packages/ai/src/models.ts` → `models.generated.ts`) provides all metadata. No network fetch needed. `getProviders()` / `getModels()` give the full catalog with api type, context window, max tokens, cost, input modalities, reasoning flag.

Alternative considered: Fetching from `https://models.dev/api.json` (like `generate-models.ts` does). Rejected because the data is already available locally in the generated registry, and a network dependency during model setup is undesirable.

## Model Catalog Storage

**`settings.json` via `SettingsManager`** for deployment catalog, **`auth.json` via `AuthStorage`** for endpoint credentials.

Alternatives considered:

1. **Everything in `models.json`**: ModelRegistry already parses custom providers from this file. But `models.json` is for static provider configuration (baseUrl, apiKey, model overrides). Foundry deployments are user-curated at runtime via `/foundry add`. Mixing static config with dynamic catalog management in the same file is awkward.

2. **Everything in `settings.json`**: Endpoint URLs would be alongside deployments. But `AuthStorage.getApiKey()` needs the endpoint to acquire tokens. Cross-referencing between SettingsManager and AuthStorage creates coupling.

3. **Split** (chosen): Endpoint credentials in `auth.json` (managed by AuthStorage, file-locked, 0600 permissions). Deployment catalog in `settings.json` (managed by SettingsManager). Each deployment references its endpoint via `endpointKey`. Benefits:
   - AuthStorage owns all credential-adjacent data
   - SettingsManager owns all user preferences
   - `getApiKey("azure-foundry-1")` needs only `auth.json` to find the endpoint and acquire a token
   - `/foundry remove-endpoint` cleans up both stores
   - File permissions: `auth.json` is 0600, `settings.json` doesn't need to be

## Env Var Activation (Headless/CI)

`AZURE_FOUNDRY_ENDPOINT` env var auto-registers an endpoint credential under `"azure-foundry-env"` in `auth.json`. Models still come from `settings.json` — env var only handles the endpoint, not the catalog.

For fully headless CI without pre-existing `settings.json`, a future `AZURE_FOUNDRY_MODELS` env var could specify deployments inline. Not in scope for initial implementation.

## Foundry API Shape

The exact wire API exposed by Foundry per model family must be confirmed during implementation.

Current working assumption: if Foundry serves all model families through an OpenAI-compatible endpoint, injected Foundry deployments should use `api: "openai-completions"` and source models should provide metadata only. If Foundry passes through native provider protocols, `/foundry add` should auto-detect or let the user override the API.
