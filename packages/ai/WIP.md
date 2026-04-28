# WIP: Azure Foundry OAuth Provider

## What

An `OAuthProviderInterface` implementation that lets you use any model (OpenAI, Anthropic, Google, etc.) through Azure Foundry endpoints. It uses Azure AD tokens via `@azure/identity` (`DefaultAzureCredential`).

## Files changed

- **`src/utils/oauth/azure-foundry.ts`** — the provider implementation
- **`src/utils/oauth/index.ts`** — registered in `BUILT_IN_OAUTH_PROVIDERS`, added export
- **`package.json`** — `@azure/identity` as optional peer dependency
- **`test/azure-foundry-oauth.test.ts`** — 13 tests
- **`CHANGELOG.md`** — entry under `[Unreleased]`

## Key design decisions

### No new streaming provider
Azure Foundry proxies models using the same wire protocol as the native provider (OpenAI chat completions, Anthropic messages, etc.). So we reuse existing providers (`streamOpenAICompletions`, `streamAnthropic`, etc.) — just swap the base URL and auth.

### Auth goes through `modifyModels()` + `getApiKey()`
- `getApiKey()` returns the raw Azure AD Bearer token
- For **OpenAI-based models**: the OpenAI SDK automatically sends `apiKey` as `Authorization: Bearer <token>` — no special handling needed
- For **Anthropic models**: the Anthropic SDK sends `apiKey` as `x-api-key`, NOT `Authorization: Bearer`. So `modifyModels()` injects an explicit `Authorization: Bearer <token>` header into `model.headers` for `anthropic-messages` API models only

### `@azure/identity` is dynamically imported
It's an optional peer dep. The import is lazy — if not installed, it throws a clear error at login/refresh time. Type is hand-defined (`AzureIdentityModule`) to avoid needing the package at compile time (suppressed with `@ts-expect-error`).

### Token refresh uses Azure's credential chain
`refresh` field in `OAuthCredentials` is empty string. `refreshToken()` calls `DefaultAzureCredential.getToken()` fresh each time — the Azure SDK manages the underlying credential chain (az login session, managed identity, env vars, etc.). The existing `getOAuthApiKey()` in `index.ts` checks `Date.now() >= creds.expires` and calls `refreshToken()` automatically before each stream call.

### Endpoint URL stored in credentials
The user provides their Foundry endpoint URL during `login()` via `onPrompt`. Stored as `endpoint` field on `OAuthCredentials` (the type allows `[key: string]: unknown`). Preserved across `refreshToken()` calls. Used by `modifyModels()` to rewrite all models' `baseUrl`.

### Provider field is NOT changed
`modifyModels()` keeps the original `model.provider`. This means existing model filtering/UI still works.

## What's NOT done

- No integration with `coding-agent` yet (no `/login` entry, no `model-resolver` mapping)
- No docs in `packages/ai/README.md` or `packages/coding-agent/docs/providers.md`
- No real e2e test against a live Azure Foundry endpoint
- Google Vertex / Gemini models through Foundry are untested — may need similar header injection like Anthropic if their SDK doesn't use Bearer by default

## Testing notes

Tests use `vi.resetModules()` + `vi.doMock("@azure/identity", ...)` per test because the module caches `azureIdentity` at module level. Each test re-imports via `await import("../src/utils/oauth/azure-foundry.js")` to get a fresh module instance.

Run tests:
```sh
cd packages/ai
npx tsx ../../node_modules/vitest/dist/cli.js --run test/azure-foundry-oauth.test.ts
```

## How Azure Foundry auth works (context)

```ts
import { DefaultAzureCredential } from "@azure/identity";
const credential = new DefaultAzureCredential();
const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
// token.token = Bearer token string
// token.expiresOnTimestamp = ms since epoch
```

Prereq: user has run `az login` (or has managed identity / env credentials configured).
