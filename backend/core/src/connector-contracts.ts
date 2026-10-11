export type ConnectorHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type ConnectorScope =
	| { readonly kind: "addon"; readonly addonIdentifier: string }
	| { readonly kind: "group"; readonly groupIdentifier: string }
	| { readonly kind: "instance" }
	| { readonly kind: "user"; readonly userId: string };

export interface ConnectorParameterDefinition {
	readonly name: string;
	readonly location: "body" | "header" | "path" | "query";
	readonly required?: boolean;
	readonly sensitive?: boolean;
}

export interface ConnectorEndpointDefinition {
	readonly identifier: string;
	readonly path: string;
	readonly method: ConnectorHttpMethod;
	readonly parameters?: readonly ConnectorParameterDefinition[];
	readonly successStatuses: readonly number[];
	readonly response: {
		readonly format: "bytes" | "json" | "text";
		readonly requiredJsonPaths?: readonly string[];
	};
	readonly maximumResponseBytes?: number;
	readonly cacheTtlSeconds?: number;
	readonly retries?: number;
	readonly retrySafe?: boolean;
	readonly timeoutMs?: number;
}

export type ConnectorAuthentication =
	| { readonly kind: "none" }
	| { readonly kind: "api-key"; readonly secretReference: string; readonly header: string }
	| {
			readonly kind: "basic";
			readonly usernameSecretReference: string;
			readonly passwordSecretReference: string;
	  }
	| { readonly kind: "bearer"; readonly secretReference: string }
	| {
			readonly kind: "oauth2";
			readonly flow: "authorization-code-pkce" | "client-credentials" | "device-code";
			readonly clientIdSecretReference: string;
			readonly clientSecretReference?: string;
			readonly tokenEndpoint: string;
			readonly authorizationEndpoint?: string;
			readonly deviceAuthorizationEndpoint?: string;
			readonly scopes?: readonly string[];
			readonly accessTokenPath?: string;
			readonly refreshTokenPath?: string;
			readonly expiresInPath?: string;
	  };

export interface ConnectorDefinition {
	readonly identifier: string;
	readonly baseUrl: string;
	readonly allowedDomains: readonly string[];
	readonly endpoints: readonly ConnectorEndpointDefinition[];
	readonly authentication: ConnectorAuthentication;
	readonly connectionTestEndpoint: string;
	readonly quota?: {
		readonly limit: number;
		readonly windowSeconds: number;
	};
	readonly cacheTtlSeconds?: number;
	readonly retries?: number;
	readonly timeoutMs?: number;
}

export interface FrontendNetworkDefinition {
	readonly ownerIdentifier: string;
	readonly domains: readonly string[];
	readonly methods: readonly ConnectorHttpMethod[];
	readonly requiresConsent: boolean;
}
