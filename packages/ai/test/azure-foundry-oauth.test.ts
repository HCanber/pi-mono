import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "../src/utils/oauth/types.js";

const FAKE_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.fake-azure-token";
const FAKE_TOKEN_2 = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.refreshed-azure-token";
const FAKE_ENDPOINT = "https://my-resource.services.ai.azure.com";
const FAKE_EXPIRES = Date.now() + 3600 * 1000;

function makeCallbacks(overrides?: Partial<OAuthLoginCallbacks>): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onPrompt: async () => FAKE_ENDPOINT,
		onProgress: () => {},
		...overrides,
	};
}

function makeCredentials(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
	return {
		refresh: "",
		access: FAKE_TOKEN,
		expires: FAKE_EXPIRES,
		endpoint: FAKE_ENDPOINT,
		...overrides,
	};
}

function makeModel(api: Api, provider: string = "openai"): Model<Api> {
	return {
		id: `test-model-${api}`,
		name: `Test Model (${api})`,
		api,
		provider,
		baseUrl: "https://api.original.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function importProvider(): Promise<OAuthProviderInterface> {
	const mod = await import("../src/utils/oauth/azure-foundry.js");
	return mod.azureFoundryOAuthProvider;
}

describe("Azure Foundry OAuth", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("has correct id and name", async () => {
		vi.doMock("@azure/identity", () => ({
			DefaultAzureCredential: class {
				async getToken() {
					return { token: FAKE_TOKEN, expiresOnTimestamp: FAKE_EXPIRES };
				}
			},
		}));
		const provider = await importProvider();
		expect(provider.id).toBe("azure-foundry");
		expect(provider.name).toBe("Azure Foundry");
	});

	describe("login", () => {
		it("acquires token via DefaultAzureCredential and stores endpoint", async () => {
			vi.doMock("@azure/identity", () => ({
				DefaultAzureCredential: class {
					async getToken() {
						return { token: FAKE_TOKEN, expiresOnTimestamp: FAKE_EXPIRES };
					}
				},
			}));
			const provider = await importProvider();

			const creds = await provider.login(makeCallbacks());

			expect(creds.access).toBe(FAKE_TOKEN);
			expect(creds.expires).toBe(FAKE_EXPIRES);
			expect(creds.refresh).toBe("");
			expect(creds.endpoint).toBe(FAKE_ENDPOINT);
		});

		it("throws when endpoint is empty", async () => {
			vi.doMock("@azure/identity", () => ({
				DefaultAzureCredential: class {
					async getToken() {
						return { token: FAKE_TOKEN, expiresOnTimestamp: FAKE_EXPIRES };
					}
				},
			}));
			const provider = await importProvider();

			await expect(provider.login(makeCallbacks({ onPrompt: async () => "" }))).rejects.toThrow(
				"Azure Foundry endpoint URL is required",
			);
		});

		it("throws when @azure/identity is not installed", async () => {
			vi.doMock("@azure/identity", () => {
				throw new Error("Cannot find module '@azure/identity'");
			});
			const provider = await importProvider();

			await expect(provider.login(makeCallbacks())).rejects.toThrow("@azure/identity is required");
		});
	});

	describe("refreshToken", () => {
		it("fetches a new token and preserves endpoint", async () => {
			vi.doMock("@azure/identity", () => ({
				DefaultAzureCredential: class {
					async getToken() {
						return { token: FAKE_TOKEN_2, expiresOnTimestamp: FAKE_EXPIRES + 3600000 };
					}
				},
			}));
			const provider = await importProvider();

			const refreshed = await provider.refreshToken(makeCredentials());

			expect(refreshed.access).toBe(FAKE_TOKEN_2);
			expect(refreshed.expires).toBe(FAKE_EXPIRES + 3600000);
			expect(refreshed.endpoint).toBe(FAKE_ENDPOINT);
		});
	});

	describe("getApiKey", () => {
		it("returns the access token", async () => {
			vi.doMock("@azure/identity", () => ({
				DefaultAzureCredential: class {
					async getToken() {
						return { token: FAKE_TOKEN, expiresOnTimestamp: FAKE_EXPIRES };
					}
				},
			}));
			const provider = await importProvider();
			const apiKey = provider.getApiKey(makeCredentials());
			expect(apiKey).toBe(FAKE_TOKEN);
		});
	});

	describe("modifyModels", () => {
		let provider: OAuthProviderInterface;
		const credentials = makeCredentials();

		beforeEach(async () => {
			vi.doMock("@azure/identity", () => ({
				DefaultAzureCredential: class {
					async getToken() {
						return { token: FAKE_TOKEN, expiresOnTimestamp: FAKE_EXPIRES };
					}
				},
			}));
			provider = await importProvider();
		});

		it("rewrites baseUrl for all models", () => {
			const models = [makeModel("openai-completions"), makeModel("google-generative-ai", "google")];

			const modified = provider.modifyModels!(models, credentials);

			for (const m of modified) {
				expect(m.baseUrl).toBe(FAKE_ENDPOINT);
			}
		});

		it("does not mutate original models", () => {
			const original = makeModel("openai-completions");
			const originalBaseUrl = original.baseUrl;

			provider.modifyModels!([original], credentials);

			expect(original.baseUrl).toBe(originalBaseUrl);
		});

		it("preserves original provider", () => {
			const model = makeModel("openai-completions", "openai");
			const [modified] = provider.modifyModels!([model], credentials);
			expect(modified.provider).toBe("openai");
		});

		it("injects Authorization: Bearer header for anthropic-messages models", () => {
			const model = makeModel("anthropic-messages", "anthropic");
			const [modified] = provider.modifyModels!([model], credentials);

			expect(modified.headers).toEqual({ Authorization: `Bearer ${FAKE_TOKEN}` });
		});

		it("preserves existing headers when injecting Bearer for anthropic", () => {
			const model = { ...makeModel("anthropic-messages", "anthropic"), headers: { "X-Custom": "value" } };
			const [modified] = provider.modifyModels!([model], credentials);

			expect(modified.headers).toEqual({
				"X-Custom": "value",
				Authorization: `Bearer ${FAKE_TOKEN}`,
			});
		});

		it("does NOT inject Authorization header for openai-completions models", () => {
			const model = makeModel("openai-completions", "openai");
			const [modified] = provider.modifyModels!([model], credentials);

			expect(modified.headers).toBeUndefined();
		});

		it("strips trailing slashes from endpoint", () => {
			const creds = makeCredentials({ endpoint: "https://my-resource.services.ai.azure.com///" });
			const model = makeModel("openai-completions");
			const [modified] = provider.modifyModels!([model], creds);

			expect(modified.baseUrl).toBe("https://my-resource.services.ai.azure.com");
		});
	});
});
