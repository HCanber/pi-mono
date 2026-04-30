import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

interface TokenEntry {
	token: string;
	expiresOnTimestamp: number;
}

/**
 * Per-key Azure AD token cache using DefaultAzureCredential.
 *
 * A single DefaultAzureCredential instance is created lazily on first use.
 * Tokens are cached and refreshed 60s before expiry.
 */
export class AzureFoundryTokenCache {
	private cached: TokenEntry | undefined;
	private credential: TokenCredential | undefined;

	async getToken(): Promise<string | undefined> {
		if (this.cached && Date.now() < this.cached.expiresOnTimestamp - 60_000) {
			return this.cached.token;
		}

		if (!this.credential) {
			this.credential = new DefaultAzureCredential();
		}

		const result = await this.credential.getToken("https://cognitiveservices.azure.com/.default");
		if (!result) return undefined;

		this.cached = { token: result.token, expiresOnTimestamp: result.expiresOnTimestamp };
		return result.token;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}
