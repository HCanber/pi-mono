# Plan: Azure Foundry CLI Integration

Azure Foundry routes model traffic through Azure endpoints using Azure AD Bearer tokens. This plan integrates Foundry into `coding-agent` through a dedicated `/foundry` management flow.

See `DECISIONS.md` for architecture rationale and rejected alternatives.

## Constraints

- Not all models are deployed on a given Foundry resource
- Each user has a different set of deployed models
- Deployment names can differ from canonical model IDs (e.g., `claude-opus-4-7` deployed as `my-claude`)
- A user may have multiple Foundry endpoints simultaneously (different resources, regions, or tenants)

## Architecture

Multiple dedicated providers following the GitHub Copilot pattern, one per Foundry endpoint:

- Each endpoint gets a user-named credential in `auth.json` (e.g., `azure-foundry-1`, `azure-foundry-2`)
- New credential type `"azure-foundry"` stores endpoint URL; Azure AD tokens acquired on-demand via `DefaultAzureCredential`
- Models have `provider: "azure-foundry-1"` (matching the credential key) with varying `api` fields
- User-curated model catalog stored in `settings.json` via `SettingsManager`, each deployment references its endpoint key
- Auth chain works unmodified: `hasConfiguredAuth("azure-foundry-1")` finds the credential, `getApiKey("azure-foundry-1")` acquires a fresh Azure AD token

### auth.json shape

```json
{
  "github-copilot": { "type": "oauth", "refresh": "...", "access": "...", "expires": 1777469169000 },
  "azure-foundry-1": { "type": "azure-foundry", "endpoint": "https://myresource.services.ai.azure.com" },
  "azure-foundry-2": { "type": "azure-foundry", "endpoint": "https://other.services.ai.azure.com" }
}
```

### settings.json shape (deployments)

```json
{
  "foundryDeployments": [
    {
      "endpointKey": "azure-foundry-1",
      "sourceProvider": "anthropic",
      "sourceModelId": "claude-opus-4-7",
      "deploymentId": "my-claude"
    },
    {
      "endpointKey": "azure-foundry-2",
      "sourceProvider": "openai",
      "sourceModelId": "gpt-5.4",
      "deploymentId": "gpt-5.4",
      "name": "GPT 5.4 (EU)"
    }
  ]
}
```

## Implementation Steps

### Phase 1: Core

#### Step 1: New credential type in `AuthStorage`

Add `AzureFoundryCredential` to `packages/coding-agent/src/core/auth-storage.ts`:

```ts
export type AzureFoundryCredential = {
  type: "azure-foundry";
  endpoint: string;
};

export type AuthCredential = ApiKeyCredential | OAuthCredential | AzureFoundryCredential;
```

Changes to `AuthStorage`:

- `hasAuth(provider)`: already works — checks `this.data[provider]`, finds the credential.
- `getApiKey(provider)`: add handler for `type === "azure-foundry"` — acquire Azure AD token via `DefaultAzureCredential` (from `@azure/identity`). Cache token in-memory with expiry to avoid re-acquiring on every call. Returns the Bearer token string.
- `getAuthStatus(provider)`: recognize `"azure-foundry"` type → `{ configured: true, source: "stored" }`.
- New helpers:
  - `getFoundryEndpoints(): Array<{ key: string; endpoint: string }>` — returns all `type === "azure-foundry"` entries.
  - `addFoundryEndpoint(key: string, endpoint: string): void` — stores `{ type: "azure-foundry", endpoint }` under the given key.
  - `removeFoundryEndpoint(key: string): void` — removes the entry.

#### Step 2: Remove obsolete `packages/ai` Azure Foundry OAuth files

Required changes:

- Remove the obsolete `packages/ai` OAuth-provider implementation:
  - Delete `packages/ai/src/utils/oauth/azure-foundry.ts`.
  - Remove its exports/imports/registration from `packages/ai/src/utils/oauth/index.ts`.
  - Delete `packages/ai/test/azure-foundry-oauth.test.ts`.
  - Remove the `@azure/identity` optional peer dependency from `packages/ai/package.json` if no other `packages/ai` code uses it.
  - Remove the stale `packages/ai/CHANGELOG.md` entry for the `packages/ai` OAuth provider.
  - Delete `packages/ai/WIP.md`.
- Do not expose Azure Foundry in the generic OAuth provider selector used by `/login`.
- Put endpoint creation in `/foundry add-endpoint`, which directly calls `authStorage.addFoundryEndpoint(key, endpoint)`.
- Put token acquisition in a shared helper used by endpoint validation and `AuthStorage.getApiKey()`; do not persist Azure AD access tokens.

#### Step 3: Settings schema — `FoundryDeployment` in `SettingsManager`

Add to `packages/coding-agent/src/core/settings-manager.ts`:

```ts
export interface FoundryDeployment {
  endpointKey: string;      // auth.json key, e.g., "azure-foundry-1"
  sourceProvider: string;   // e.g., "anthropic"
  sourceModelId: string;    // e.g., "claude-opus-4-7"
  deploymentId: string;     // Foundry deployment name (defaults to sourceModelId)
  name?: string;            // display name override
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}
```

Add getters/setters:
- `getFoundryDeployments(): FoundryDeployment[]`
- `getFoundryDeploymentsForEndpoint(endpointKey: string): FoundryDeployment[]`
- `addFoundryDeployment(deployment: FoundryDeployment): void`
- `updateFoundryDeployment(endpointKey: string, deploymentId: string, updates: Partial<Pick<FoundryDeployment, "deploymentId" | "name" | "cost">>): void`
- `removeFoundryDeployment(endpointKey: string, deploymentId: string): void`
- `removeFoundryDeploymentsForEndpoint(endpointKey: string): void`

#### Step 4: `ModelRegistry` — load Foundry deployments

Add `setFoundryDeployments(deployments: FoundryDeployment[])` to `ModelRegistry`.

In `loadModels()`, after the existing OAuth `modifyModels` loop (~L381), convert each `FoundryDeployment` to a `Model<Api>`:

- Look up source model via built-in registry: `getModel(deployment.sourceProvider, deployment.sourceModelId)`
- Copy `api`, `contextWindow`, `maxTokens`, `reasoning`, `input`, `cost` from source
- Set `provider: deployment.endpointKey` (e.g., `"azure-foundry-1"`)
- Set `id: deployment.deploymentId`
- Set `baseUrl` from `authStorage.get(deployment.endpointKey).endpoint`
- Override `name` and `cost` if deployment specifies them
- Register request auth config for each endpoint key using `storeProviderRequestConfig(endpointKey, { authHeader: true })`
- Append to `combined`

No `modifyModels()` call needed for Foundry models.

Do not inject `Authorization` into `model.headers` during model creation. Apply Bearer auth per request through `getApiKeyAndHeaders()` via `authHeader`.

#### Step 5: Interactive management (`/foundry` command)

**`/foundry add-endpoint`:**
1. User enters a name (e.g., `my-resource`, auto-prefixed to `azure-foundry-my-resource`)
2. User enters endpoint URL
3. Validate: acquire Azure AD token to confirm access
4. `authStorage.addFoundryEndpoint(key, endpoint)`

**`/foundry remove-endpoint`:**
1. List current endpoints from `authStorage.getFoundryEndpoints()`
2. User picks one
3. `settingsManager.removeFoundryDeploymentsForEndpoint(key)` — remove associated models
4. `authStorage.removeFoundryEndpoint(key)`
5. `modelRegistry.refresh()`

**`/foundry add`:**
1. List available endpoints. If only one, auto-select. If none, prompt to add one first.
2. Present models from built-in registry (`getProviders()` / `getModels()`)
3. User picks source model (e.g., `anthropic/claude-opus-4-7`)
4. User enters deployment ID (defaults to source model ID)
5. Optional: customize display name, cost overrides
6. `settingsManager.addFoundryDeployment(...)` → persists
7. `modelRegistry.refresh()`

**`/foundry modify`:**
1. List current deployments, user picks one
2. Show current values for deployment ID, display name, cost
3. User edits fields (pre-filled with current values)
4. `settingsManager.updateFoundryDeployment(endpointKey, deploymentId, updates)` → persists
5. `modelRegistry.refresh()`

**`/foundry remove`:** List deployments, pick one, `settingsManager.removeFoundryDeployment(endpointKey, deploymentId)`, refresh.

**`/foundry list`:** Show endpoints and their deployments.

#### Step 6: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — post endpoint add

After `/foundry add-endpoint` succeeds, check if `settingsManager.getFoundryDeploymentsForEndpoint(endpointKey)` is empty. If so, prompt the user to run `/foundry add` to configure models.

For model auto-selection: `availableModels.filter((model) => model.provider === endpointKey)` finds user's models for that endpoint.

#### Step 7: Env var activation

Detect `AZURE_FOUNDRY_ENDPOINT` at startup. Optionally `AZURE_FOUNDRY_KEY` for the credential name (defaults to `azure-foundry-env`).

**Insertion point**: `createAgentSessionServices()` in `packages/coding-agent/src/core/agent-session-services.ts` (~L136).

Sequence:
1. `authStorage` created (L134)
2. Detect `AZURE_FOUNDRY_ENDPOINT` → `authStorage.addFoundryEndpoint("azure-foundry-env", endpoint)`
3. `settingsManager` + `modelRegistry` created
4. `modelRegistry.setFoundryDeployments(settingsManager.getFoundryDeployments())`
5. `modelRegistry.refresh()` → loads foundry models with endpoint baseUrl; Authorization is resolved per request in `getApiKeyAndHeaders()`
6. Extensions register providers (L147-157)
7. Services returned → model resolution downstream

Note: env var activation only registers the endpoint. Models still come from `settings.json`. For fully headless CI, pre-populate `settings.json` with deployments or add `AZURE_FOUNDRY_MODELS` env var (future enhancement).

### Phase 2: Docs

#### Step 8: `packages/coding-agent/src/cli/args.ts` — env var docs (~L320)

- `AZURE_FOUNDRY_ENDPOINT` — Foundry endpoint URL (auto-registers as `azure-foundry-env`)
- `AZURE_FOUNDRY_KEY` — optional credential name override

#### Step 9: `packages/coding-agent/README.md`

Add "Azure Foundry" to Subscriptions list (~L104).

#### Step 10: `packages/coding-agent/docs/providers.md`

Add "Azure Foundry" section under Subscriptions (~L22):
- Prerequisites: `az login` or `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_CLIENT_SECRET`
- Env vars: `AZURE_FOUNDRY_ENDPOINT=<url>`
- `/foundry add-endpoint`, `/foundry add/modify/remove/list` commands

## Verification

1. `npm run check` from repo root
2. Manual: `/foundry add-endpoint` → name + URL → `/foundry add` → pick model → works
3. Manual: second endpoint → `/foundry add-endpoint` → `/foundry add` → pick endpoint → pick model
4. Manual: `AZURE_FOUNDRY_ENDPOINT=https://... pi` → endpoint auto-registered
5. Manual: `/foundry list`, `/foundry remove`, `/foundry remove-endpoint`
6. Manual: streaming through Foundry with Bearer auth works
7. Manual: two endpoints with same model (different deployment IDs) → both appear in model selector
