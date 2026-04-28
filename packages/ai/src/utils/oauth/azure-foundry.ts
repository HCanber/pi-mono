/**
 * Azure Foundry OAuth flow.
 *
 * Uses Azure AD tokens via @azure/identity (DefaultAzureCredential) to authenticate
 * against Azure Foundry endpoints that proxy OpenAI, Anthropic, Google, and other models.
 *
 * Prerequisites: user must have run `az login` or have another credential source
 * configured for DefaultAzureCredential.
 */

import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const AZURE_COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default";

type AzureFoundryCredentials = OAuthCredentials & {
	endpoint: string;
};

type AzureIdentityModule = {
	DefaultAzureCredential: new () => {
		getToken(scope: string): Promise<{ token: string; expiresOnTimestamp: number }>;
	};
};

let azureIdentity: AzureIdentityModule | null = null;

async function getAzureIdentity(): Promise<AzureIdentityModule> {
	if (azureIdentity) return azureIdentity;
	try {
		// @ts-expect-error - @azure/identity is an optional peer dependency
		azureIdentity = (await import("@azure/identity")) as unknown as AzureIdentityModule;
		return azureIdentity;
	} catch {
		throw new Error(
			"@azure/identity is required for Azure Foundry authentication. Install it with: npm install @azure/identity",
		);
	}
}

async function acquireToken(): Promise<{ token: string; expiresOnTimestamp: number }> {
	const { DefaultAzureCredential } = await getAzureIdentity();
	const credential = new DefaultAzureCredential();
	return credential.getToken(AZURE_COGNITIVE_SCOPE);
}

export const azureFoundryOAuthProvider: OAuthProviderInterface = {
	id: "azure-foundry",
	name: "Azure Foundry",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const endpoint = await callbacks.onPrompt({
			message: "Enter your Azure Foundry endpoint URL",
			placeholder: "https://<resource>.services.ai.azure.com",
		});

		if (!endpoint) {
			throw new Error("Azure Foundry endpoint URL is required");
		}

		callbacks.onProgress?.("Acquiring Azure AD token via DefaultAzureCredential...");

		const { token, expiresOnTimestamp } = await acquireToken();

		return {
			refresh: "",
			access: token,
			expires: expiresOnTimestamp,
			endpoint,
		} satisfies AzureFoundryCredentials;
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as AzureFoundryCredentials;
		const { token, expiresOnTimestamp } = await acquireToken();
		return {
			refresh: "",
			access: token,
			expires: expiresOnTimestamp,
			endpoint: creds.endpoint,
		} satisfies AzureFoundryCredentials;
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const creds = credentials as AzureFoundryCredentials;
		const endpoint = creds.endpoint.replace(/\/+$/, "");

		return models.map((m) => {
			const updated = { ...m, baseUrl: endpoint };

			// Anthropic SDK sends apiKey as x-api-key, not Authorization: Bearer.
			// Azure Foundry expects Bearer auth, so inject the header explicitly.
			if (m.api === "anthropic-messages") {
				updated.headers = {
					...m.headers,
					Authorization: `Bearer ${creds.access}`,
				};
			}

			return updated;
		});
	},
};
