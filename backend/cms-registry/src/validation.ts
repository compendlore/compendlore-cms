import type {
	ConnectorParameterDefinition,
	CoreJsonValue,
	RegistryMutationCandidate,
} from "../../core/src/index.js";
import {
	contributionKey,
	contributionTypes,
	type ConfigurationFieldDefinition,
	type ContributionDefinition,
	type ContributionOwner,
} from "./contracts.js";
import { RegistryError } from "./errors.js";
import {
	messageAcknowledgements,
	messageAudienceKinds,
	messageChannels,
	messageDeliveryProfiles,
	messageDurabilities,
	messagePayloadFieldTypes,
	messagePresentations,
	messagePriorities,
} from "./messaging.js";
import {
	statisticAggregations,
	statisticConsentPolicies,
	statisticDimensionValueTypes,
	statisticGranularities,
	statisticMetricKinds,
	statisticSensitivities,
	statisticValueTypes,
} from "./statistics.js";
import { validateThemeContract } from "./themes.js";

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const semverPattern =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const knownContributionTypes = new Set<ContributionDefinition["type"]>(contributionTypes);
const ownerKinds = new Set<ContributionOwner["kind"]>([
	"addon",
	"core",
	"instance",
	"native-module",
]);
const withdrawalPolicies = new Set<ContributionDefinition["withdrawalPolicy"]>([
	"archive",
	"block-uninstall",
	"delete",
	"preserve-data",
]);
const replacementPolicies = new Set<NonNullable<ContributionDefinition["replacementPolicy"]>>([
	"explicit",
	"forbidden",
	"same-owner",
]);
const apiAudiences = ["internal", "public", "site"] as const;
const apiHttpMethods = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;
const connectorParameterLocations = ["body", "header", "path", "query"] as const;
const connectorResponseFormats = ["bytes", "json", "text"] as const;
const connectorAuthenticationKinds = ["none", "api-key", "basic", "bearer", "oauth2"] as const;
const connectorOAuthFlows = [
	"authorization-code-pkce",
	"client-credentials",
	"device-code",
] as const;

export function validateContributionDefinition(definition: ContributionDefinition): void {
	if (!isRecord(definition)) throw invalid("The declaration is invalid.");
	if (!knownContributionTypes.has(definition.type)) {
		throw invalid("The declaration is invalid.");
	}
	validateIdentifier(definition.identifier, "contribution");
	validateOwner(definition.owner);
	if (!withdrawalPolicies.has(definition.withdrawalPolicy)) {
		throw invalid("The declaration is invalid.");
	}
	if (
		definition.replacementPolicy !== undefined &&
		!replacementPolicies.has(definition.replacementPolicy)
	) {
		throw invalid("The declaration is invalid.");
	}
	if (typeof definition.version !== "string" || !semverPattern.test(definition.version)) {
		throw invalid("The declaration is invalid.");
	}
	const key = contributionKey(definition.type, definition.identifier);
	const dependencies = new Set<string>();
	assertOptionalArray(definition.dependencies, "dependencies");
	for (const dependency of definition.dependencies ?? []) {
		if (!isRecord(dependency)) throw invalid("The declaration is invalid.");
		validateIdentifier(dependency.contributionKey, "dependency");
		if (dependency.contributionKey === key) throw invalid("The declaration is invalid.");
		if (dependencies.has(dependency.contributionKey)) {
			throw invalid("The declaration is invalid.");
		}
		dependencies.add(dependency.contributionKey);
		if (
			dependency.versionRange !== undefined &&
			!/^(?:\^|~|>=|>)?\s*(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
				dependency.versionRange,
			)
		) {
			throw invalid("The declaration is invalid.");
		}
	}
	assertOptionalArray(definition.requiredCapabilities, "required capabilities");
	const requiredCapabilities = definition.requiredCapabilities ?? [];
	if (requiredCapabilities.length > 256) {
		throw invalid("The declaration is invalid.");
	}
	for (const capability of requiredCapabilities) {
		validateIdentifier(capability, "capability");
	}
	validateUniqueValues(requiredCapabilities, "required capability");
	if (definition.type === "method" && !definition.method) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.type !== "method" && definition.method) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.type === "api-endpoint" && !definition.endpoint) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.type !== "api-endpoint" && definition.endpoint) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.method) {
		if (definition.method.timeoutMs < 1 || definition.method.timeoutMs > 120_000) {
			throw invalid("The declaration is invalid.");
		}
		if (definition.method.requiredCapability) {
			validateIdentifier(definition.method.requiredCapability, "method permission");
		}
	}
	if (definition.endpoint) {
		validateEndpoint(definition.endpoint);
		const methodKey = contributionKey("method", definition.endpoint.businessMethodIdentifier);
		const methodDependency = definition.dependencies?.find(
			(dependency) => dependency.contributionKey === methodKey,
		);
		if (!methodDependency || methodDependency.optional) {
			throw invalid("The API endpoint must require its registered business method.");
		}
	}
	if (definition.type === "connector" && !definition.connector) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.type !== "connector" && definition.connector) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.connector) validateConnector(definition.connector);
	if (definition.type === "frontend-network" && !definition.frontendNetwork) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.type !== "frontend-network" && definition.frontendNetwork) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.frontendNetwork) validateFrontendNetwork(definition, definition.frontendNetwork);
	validateStatisticContract(definition);
	validateMessagingContract(definition);
	validateThemeContract(definition);
	validateConfiguration(definition);
	validateTranslations(definition.translations);
	if (definition.payload !== undefined) assertJsonValue(definition.payload);
	if (definition.replaces !== undefined) {
		validateIdentifier(definition.replaces, "replacement");
		if (definition.replacementPolicy !== "explicit") {
			throw invalid("The declaration is invalid.");
		}
	}
}

function validateStatisticContract(definition: ContributionDefinition): void {
	assertExclusiveContract(definition, "event", "statisticEvent");
	assertExclusiveContract(definition, "dimension", "statisticDimension");
	assertExclusiveContract(definition, "metric", "statisticMetric");
	assertExclusiveContract(definition, "statistic-policy", "statisticPolicy");

	if (definition.statisticEvent) {
		if (!isRecord(definition.statisticEvent)) {
			throw invalid("The declaration is invalid.");
		}
		if (!semverPattern.test(definition.statisticEvent.schemaVersion)) {
			throw invalid("The declaration is invalid.");
		}
		validateLocalizedText(definition.statisticEvent.purpose);
		assertKnownValue(
			definition.statisticEvent.sensitivity,
			statisticSensitivities,
			"statistic sensitivity",
		);
		validateRetention(definition.statisticEvent.retentionDays);
		assertKnownValue(
			definition.statisticEvent.timestampSource,
			["core", "producer"],
			"statistic timestamp source",
		);
		if (!isRecord(definition.statisticEvent.fields)) {
			throw invalid("The declaration is invalid.");
		}
		for (const [fieldName, field] of Object.entries(definition.statisticEvent.fields)) {
			if (!isRecord(field)) throw invalid("The declaration is invalid.");
			validateIdentifier(fieldName, "statistic field");
			assertNonSensitiveStatisticName(fieldName);
			assertKnownValue(field.type, statisticValueTypes, "statistic value type");
			if (typeof field.required !== "boolean") {
				throw invalid("The declaration is invalid.");
			}
			assertOptionalArray(field.allowedValues, "allowed statistic values");
			if (
				field.maximumLength !== undefined &&
				(field.type !== "string" ||
					!Number.isSafeInteger(field.maximumLength) ||
					field.maximumLength < 1 ||
					field.maximumLength > 4_096)
			) {
				throw invalid("The declaration is invalid.");
			}
			validateScalarValues(field.allowedValues, field.type);
		}
		validateUniqueIdentifiers(
			definition.statisticEvent.dimensionIdentifiers,
			"statistic dimension",
		);
	}

	if (definition.statisticDimension) {
		if (!isRecord(definition.statisticDimension)) {
			throw invalid("The declaration is invalid.");
		}
		assertNonSensitiveStatisticName(definition.identifier);
		validateLocalizedText(definition.statisticDimension.purpose);
		assertKnownValue(
			definition.statisticDimension.valueType,
			statisticDimensionValueTypes,
			"statistic dimension type",
		);
		assertKnownValue(
			definition.statisticDimension.sensitivity,
			statisticSensitivities,
			"statistic sensitivity",
		);
		if (
			definition.statisticDimension.pseudonymized !== undefined &&
			typeof definition.statisticDimension.pseudonymized !== "boolean"
		) {
			throw invalid("The declaration is invalid.");
		}
		assertOptionalArray(definition.statisticDimension.allowedValues, "allowed dimension values");
		if (
			!Number.isSafeInteger(definition.statisticDimension.cardinalityLimit) ||
			definition.statisticDimension.cardinalityLimit < 1 ||
			definition.statisticDimension.cardinalityLimit > 100_000
		) {
			throw invalid("The declaration is invalid.");
		}
		validateScalarValues(
			definition.statisticDimension.allowedValues,
			definition.statisticDimension.valueType,
		);
	}

	if (definition.statisticMetric) {
		if (!isRecord(definition.statisticMetric)) {
			throw invalid("The declaration is invalid.");
		}
		assertKnownValue(definition.statisticMetric.kind, statisticMetricKinds, "metric type");
		validateIdentifier(definition.statisticMetric.eventIdentifier, "statistic event");
		if (definition.statisticMetric.field) {
			validateIdentifier(definition.statisticMetric.field, "metric field");
		}
		if (
			typeof definition.statisticMetric.unit !== "string" ||
			!/^[A-Za-z][A-Za-z0-9._%/-]{0,31}$/.test(definition.statisticMetric.unit)
		) {
			throw invalid("The declaration is invalid.");
		}
		assertKnownValue(
			definition.statisticMetric.aggregation,
			statisticAggregations,
			"statistic aggregation",
		);
		assertRequiredArray(definition.statisticMetric.granularities, "statistic granularities");
		if (definition.statisticMetric.granularities.length === 0) {
			throw invalid("The declaration is invalid.");
		}
		for (const granularity of definition.statisticMetric.granularities) {
			assertKnownValue(granularity, statisticGranularities, "statistic granularity");
		}
		validateUniqueValues(definition.statisticMetric.granularities, "statistic granularity");
		if (definition.statisticMetric.timezone !== "UTC") {
			throw invalid("The declaration is invalid.");
		}
		validateUniqueIdentifiers(
			definition.statisticMetric.dimensionIdentifiers,
			"statistic dimension",
		);
	}

	if (definition.statisticPolicy) {
		if (!isRecord(definition.statisticPolicy)) {
			throw invalid("The declaration is invalid.");
		}
		validateIdentifier(definition.statisticPolicy.purposeIdentifier, "statistic purpose");
		assertKnownValue(
			definition.statisticPolicy.consent,
			statisticConsentPolicies,
			"statistic consent policy",
		);
		if (typeof definition.statisticPolicy.enabledByDefault !== "boolean") {
			throw invalid("The declaration is invalid.");
		}
		validateRetention(definition.statisticPolicy.retentionDays);
		if (
			!Number.isFinite(definition.statisticPolicy.sampleRate) ||
			definition.statisticPolicy.sampleRate < 0 ||
			definition.statisticPolicy.sampleRate > 1
		) {
			throw invalid("The declaration is invalid.");
		}
		if (
			definition.statisticPolicy.anonymizeAfterDays !== undefined &&
			(!Number.isSafeInteger(definition.statisticPolicy.anonymizeAfterDays) ||
				definition.statisticPolicy.anonymizeAfterDays < 0 ||
				definition.statisticPolicy.anonymizeAfterDays > definition.statisticPolicy.retentionDays)
		) {
			throw invalid("The declaration is invalid.");
		}
	}
}

function validateMessagingContract(definition: ContributionDefinition): void {
	assertExclusiveContract(definition, "message-topic", "messageTopic");
	assertExclusiveContract(definition, "message-template", "messageTemplate");
	assertExclusiveContract(definition, "message-action", "messageAction");
	assertExclusiveContract(definition, "message-segment", "messageSegment");
	assertExclusiveContract(definition, "message-subscription", "messageSubscription");
	if (definition.messageTopic) {
		const topic = definition.messageTopic;
		if (!isRecord(topic)) throw invalid("The declaration is invalid.");
		if (!semverPattern.test(topic.schemaVersion)) {
			throw invalid("The declaration is invalid.");
		}
		validateLocalizedText(topic.purpose);
		assertKnownValue(topic.profile, messageDeliveryProfiles, "message delivery profile");
		assertKnownValue(topic.sensitivity, statisticSensitivities, "message sensitivity");
		assertKnownValue(topic.durability, messageDurabilities, "message durability");
		assertKnownValue(topic.acknowledgement, messageAcknowledgements, "message acknowledgement");
		assertKnownValue(topic.priority, messagePriorities, "message priority");
		validateRetention(topic.retentionDays);
		assertRequiredArray(topic.audiences, "message audiences");
		assertRequiredArray(topic.presentations, "message presentations");
		assertRequiredArray(topic.channels, "message channels");
		validateUniqueValues(topic.audiences, "message audience");
		validateUniqueValues(topic.presentations, "message presentation");
		validateUniqueValues(topic.channels, "message channel");
		if (
			topic.audiences.length === 0 ||
			topic.presentations.length === 0 ||
			topic.channels.length === 0
		) {
			throw invalid("The declaration is invalid.");
		}
		for (const audience of topic.audiences) {
			assertKnownValue(audience, messageAudienceKinds, "message audience");
		}
		for (const presentation of topic.presentations) {
			assertKnownValue(presentation, messagePresentations, "message presentation");
		}
		for (const channel of topic.channels) {
			assertKnownValue(channel, messageChannels, "message channel");
		}
		if (topic.profile === "simple" && topic.acknowledgement !== "none") {
			throw invalid("The declaration is invalid.");
		}
		if (topic.profile === "direct-acknowledged" && topic.acknowledgement === "none") {
			throw invalid("The declaration is invalid.");
		}
		if (typeof topic.idempotent !== "boolean") {
			throw invalid("The declaration is invalid.");
		}
		if (
			topic.maximumRecipients !== undefined &&
			(!Number.isSafeInteger(topic.maximumRecipients) ||
				topic.maximumRecipients < 1 ||
				topic.maximumRecipients > 100_000)
		) {
			throw invalid("The declaration is invalid.");
		}
		if (
			topic.profile === "direct-acknowledged" &&
			(topic.audiences.includes("broadcast") ||
				topic.maximumRecipients === undefined ||
				topic.maximumRecipients > 100)
		) {
			throw invalid("The declaration is invalid.");
		}
		if (
			topic.expiresAfterSeconds !== undefined &&
			(!Number.isSafeInteger(topic.expiresAfterSeconds) ||
				topic.expiresAfterSeconds < 1 ||
				topic.expiresAfterSeconds > 31_536_000)
		) {
			throw invalid("The declaration is invalid.");
		}
		if (!isRecord(topic.payload)) throw invalid("The declaration is invalid.");
		for (const [fieldName, field] of Object.entries(topic.payload)) {
			if (!isRecord(field)) throw invalid("The declaration is invalid.");
			validateIdentifier(fieldName, "message field");
			assertNonSensitiveMessageName(fieldName);
			assertKnownValue(field.type, messagePayloadFieldTypes, "message field type");
			if (typeof field.required !== "boolean") {
				throw invalid("The declaration is invalid.");
			}
			if (field.sensitive !== undefined && typeof field.sensitive !== "boolean") {
				throw invalid("The declaration is invalid.");
			}
			if (
				field.maximumLength !== undefined &&
				(field.type !== "string" ||
					!Number.isSafeInteger(field.maximumLength) ||
					field.maximumLength < 1 ||
					field.maximumLength > 65_536)
			) {
				throw invalid("The declaration is invalid.");
			}
		}
	}
	if (definition.messageTemplate) {
		const template = definition.messageTemplate;
		if (!isRecord(template)) throw invalid("The declaration is invalid.");
		validateIdentifier(template.topicIdentifier, "message template topic");
		if (!semverPattern.test(template.templateVersion)) {
			throw invalid("The declaration is invalid.");
		}
		validateSafeLocalizedText(template.title);
		validateSafeLocalizedText(template.body);
		if (template.summary) validateSafeLocalizedText(template.summary);
		for (const [action, labels] of Object.entries(template.actionLabels ?? {})) {
			validateIdentifier(action, "message action");
			validateSafeLocalizedText(labels);
		}
	}
	if (definition.messageAction) {
		const action = definition.messageAction;
		if (!isRecord(action)) throw invalid("The declaration is invalid.");
		validateIdentifier(action.methodIdentifier, "message action method");
		if (action.requiredCapability !== undefined)
			validateIdentifier(action.requiredCapability, "message action capability");
		if (typeof action.confirmationRequired !== "boolean")
			throw invalid("The declaration is invalid.");
	}
	if (definition.messageSegment) {
		const segment = definition.messageSegment;
		if (!isRecord(segment)) throw invalid("The declaration is invalid.");
		validateIdentifier(segment.resolverMethodIdentifier, "message segment resolver");
		validateLocalizedText(segment.purpose);
		if (
			!Number.isSafeInteger(segment.maximumRecipients) ||
			segment.maximumRecipients < 1 ||
			segment.maximumRecipients > 1_000_000
		)
			throw invalid("The declaration is invalid.");
	}
	if (definition.messageSubscription) {
		const subscription = definition.messageSubscription;
		if (!isRecord(subscription)) throw invalid("The declaration is invalid.");
		validateIdentifier(subscription.topicIdentifier, "message subscription topic");
		if (
			typeof subscription.defaultEnabled !== "boolean" ||
			typeof subscription.userControllable !== "boolean"
		)
			throw invalid("The declaration is invalid.");
	}
}

function assertExclusiveContract(
	definition: ContributionDefinition,
	type: ContributionDefinition["type"],
	property:
		| "messageAction"
		| "messageSegment"
		| "messageSubscription"
		| "messageTemplate"
		| "messageTopic"
		| "statisticDimension"
		| "statisticEvent"
		| "statisticMetric"
		| "statisticPolicy",
): void {
	const contract = definition[property];
	if (definition.type === type && !contract) {
		throw invalid("The declaration is invalid.");
	}
	if (definition.type !== type && contract) {
		throw invalid("The declaration is invalid.");
	}
}

function validateRetention(days: number): void {
	if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) {
		throw invalid("The declaration is invalid.");
	}
}

function validateScalarValues(
	values: readonly (boolean | number | string)[] | undefined,
	type: string,
): void {
	if (!values) return;
	if (values.length === 0 || values.length > 1_000) {
		throw invalid("The declaration is invalid.");
	}
	for (const value of values) {
		const expectedType = type === "duration" || type === "integer" ? "number" : type;
		if (typeof value !== expectedType || (type === "integer" && !Number.isSafeInteger(value))) {
			throw invalid("The declaration is invalid.");
		}
	}
	validateUniqueValues(values, "statistic value");
}

function validateUniqueIdentifiers(values: readonly string[] | undefined, label: string): void {
	if (!values) return;
	for (const value of values) validateIdentifier(value, label);
	validateUniqueValues(values, label);
}

function validateUniqueValues(values: readonly unknown[], label: string): void {
	if (new Set(values).size !== values.length) {
		throw invalid(`The ${label} values must be unique.`);
	}
}

function assertKnownValue(value: unknown, values: readonly unknown[], label: string): void {
	if (!values.includes(value)) throw invalid(`The ${label} value is not supported.`);
}

function assertNonSensitiveStatisticName(name: string): void {
	if (/(?:content|email|password|secret|token)/i.test(name)) {
		throw invalid("The declaration is invalid.");
	}
}

function assertNonSensitiveMessageName(name: string): void {
	if (/(?:2fa|mfa|password|recovery.?code|secret|token)/i.test(name)) {
		throw invalid("The declaration is invalid.");
	}
}

function validateSafeLocalizedText(value: Readonly<Record<string, string>>): void {
	validateLocalizedText(value);
	for (const text of Object.values(value)) {
		if (/<\/?[A-Za-z][^>]*>|javascript:|on[a-z]+\s*=/i.test(text)) {
			throw invalid("The declaration is invalid.");
		}
	}
}

function validateConnector(connector: NonNullable<ContributionDefinition["connector"]>): void {
	if (!isRecord(connector)) throw invalid("The declaration is invalid.");
	validateIdentifier(connector.identifier, "connector");
	let baseUrl: URL;
	try {
		baseUrl = new URL(connector.baseUrl);
	} catch {
		throw invalid("The declaration is invalid.");
	}
	if (
		baseUrl.protocol !== "https:" ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash ||
		(baseUrl.port && baseUrl.port !== "443")
	) {
		throw invalid("The declaration is invalid.");
	}
	if (
		!Array.isArray(connector.allowedDomains) ||
		connector.allowedDomains.length === 0 ||
		connector.allowedDomains.length > 32 ||
		new Set(connector.allowedDomains).size !== connector.allowedDomains.length
	)
		throw invalid("The declaration is invalid.");
	for (const domain of connector.allowedDomains) validateDomain(domain);
	if (!connector.allowedDomains.includes(baseUrl.hostname.toLowerCase())) {
		throw invalid("The declaration is invalid.");
	}
	if (
		!Array.isArray(connector.endpoints) ||
		connector.endpoints.length === 0 ||
		connector.endpoints.length > 128
	)
		throw invalid("The declaration is invalid.");
	const endpointIdentifiers = new Set<string>();
	for (const endpoint of connector.endpoints) {
		if (endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint))
			throw invalid("The declaration is invalid.");
		validateIdentifier(endpoint.identifier, "connector endpoint");
		if (endpointIdentifiers.has(endpoint.identifier)) throw invalid("The declaration is invalid.");
		endpointIdentifiers.add(endpoint.identifier);
		if (
			!/^\/(?:[A-Za-z0-9._~-]+|:[a-z][a-z0-9]*)(?:\/(?:[A-Za-z0-9._~-]+|:[a-z][a-z0-9]*))*$/.test(
				endpoint.path,
			)
		) {
			throw invalid("The declaration is invalid.");
		}
		assertKnownValue(endpoint.method, apiHttpMethods, "connector HTTP method");
		if (
			!Array.isArray(endpoint.successStatuses) ||
			endpoint.successStatuses.length === 0 ||
			new Set(endpoint.successStatuses).size !== endpoint.successStatuses.length ||
			endpoint.successStatuses.some(
				(status: number) => !Number.isSafeInteger(status) || status < 200 || status > 399,
			)
		) {
			throw invalid("The declaration is invalid.");
		}
		validatePositiveLimit(endpoint.maximumResponseBytes, 64 * 1024 * 1024, "response size");
		validatePositiveLimit(endpoint.timeoutMs, 120_000, "timeout");
		validateNonNegativeLimit(endpoint.retries, 5, "retry count");
		validateNonNegativeLimit(endpoint.cacheTtlSeconds, 86_400, "cache duration");
		if (endpoint.retrySafe !== undefined && typeof endpoint.retrySafe !== "boolean") {
			throw invalid("The declaration is invalid.");
		}
		if (endpoint.retries && endpoint.method !== "GET" && !endpoint.retrySafe) {
			throw invalid("The declaration is invalid.");
		}
		if (
			endpoint.response === null ||
			typeof endpoint.response !== "object" ||
			Array.isArray(endpoint.response)
		)
			throw invalid("The declaration is invalid.");
		assertKnownValue(endpoint.response.format, connectorResponseFormats, "response format");
		if (
			endpoint.response.requiredJsonPaths !== undefined &&
			(!Array.isArray(endpoint.response.requiredJsonPaths) ||
				endpoint.response.requiredJsonPaths.length > 128 ||
				new Set(endpoint.response.requiredJsonPaths).size !==
					endpoint.response.requiredJsonPaths.length)
		)
			throw invalid("The declaration is invalid.");
		for (const path of endpoint.response.requiredJsonPaths ?? []) validateJsonPath(path);
		if (endpoint.response.format !== "json" && endpoint.response.requiredJsonPaths?.length) {
			throw invalid("The declaration is invalid.");
		}
		if (
			endpoint.parameters !== undefined &&
			(!Array.isArray(endpoint.parameters) || endpoint.parameters.length > 64)
		)
			throw invalid("The declaration is invalid.");
		const parameters = new Set<string>();
		for (const parameter of endpoint.parameters ?? []) {
			if (parameter === null || typeof parameter !== "object" || Array.isArray(parameter))
				throw invalid("The declaration is invalid.");
			validateIdentifier(parameter.name, "connector parameter");
			if (parameters.has(parameter.name)) throw invalid("The declaration is invalid.");
			parameters.add(parameter.name);
			assertKnownValue(parameter.location, connectorParameterLocations, "parameter location");
			if (parameter.required !== undefined && typeof parameter.required !== "boolean")
				throw invalid("The declaration is invalid.");
			if (parameter.sensitive !== undefined && typeof parameter.sensitive !== "boolean")
				throw invalid("The declaration is invalid.");
			if (
				parameter.location === "header" &&
				["authorization", "cookie", "host"].includes(parameter.name.toLowerCase())
			) {
				throw invalid("The declaration is invalid.");
			}
		}
		for (const placeholder of endpoint.path.matchAll(/:([a-z][a-z0-9]*)/g)) {
			if (
				!endpoint.parameters?.some(
					(parameter: ConnectorParameterDefinition) =>
						parameter.name === placeholder[1] &&
						parameter.location === "path" &&
						parameter.required,
				)
			) {
				throw invalid("The declaration is invalid.");
			}
		}
	}
	if (!endpointIdentifiers.has(connector.connectionTestEndpoint)) {
		throw invalid("The declaration is invalid.");
	}
	const connectionTest = connector.endpoints.find(
		(endpoint) => endpoint.identifier === connector.connectionTestEndpoint,
	);
	if (
		connectionTest?.parameters?.some(
			(parameter: ConnectorParameterDefinition) => parameter.required,
		)
	) {
		throw invalid("The declaration is invalid.");
	}
	validateAuthentication(connector.authentication, baseUrl, new Set(connector.allowedDomains));
	validatePositiveLimit(connector.timeoutMs, 120_000, "global timeout");
	validateNonNegativeLimit(connector.retries, 5, "global retry count");
	validateNonNegativeLimit(connector.cacheTtlSeconds, 86_400, "global cache");
	if (connector.quota) {
		validatePositiveLimit(connector.quota.limit, 1_000_000, "quota");
		validatePositiveLimit(connector.quota.windowSeconds, 86_400, "quota window");
	}
}

function validateAuthentication(
	authentication: NonNullable<ContributionDefinition["connector"]>["authentication"],
	baseUrl: URL,
	allowedDomains: ReadonlySet<string>,
): void {
	if (!isRecord(authentication)) throw invalid("The declaration is invalid.");
	assertKnownValue(authentication.kind, connectorAuthenticationKinds, "authentication kind");
	if (authentication.kind === "none") return;
	if (authentication.kind === "api-key") {
		validateSecretReference(authentication.secretReference);
		if (
			!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(authentication.header) ||
			["cookie", "host"].includes(authentication.header.toLowerCase())
		) {
			throw invalid("The declaration is invalid.");
		}
		return;
	}
	if (authentication.kind === "basic") {
		validateSecretReference(authentication.usernameSecretReference);
		validateSecretReference(authentication.passwordSecretReference);
		return;
	}
	if (authentication.kind === "bearer") {
		validateSecretReference(authentication.secretReference);
		return;
	}
	assertKnownValue(authentication.flow, connectorOAuthFlows, "OAuth flow");
	validateSecretReference(authentication.clientIdSecretReference);
	if (authentication.clientSecretReference)
		validateSecretReference(authentication.clientSecretReference);
	validateEndpointReference(authentication.tokenEndpoint, "OAuth token");
	if (authentication.flow === "client-credentials" && !authentication.clientSecretReference) {
		throw invalid("The declaration is invalid.");
	}
	if (authentication.flow === "authorization-code-pkce" && !authentication.authorizationEndpoint) {
		throw invalid("The declaration is invalid.");
	}
	if (authentication.flow === "device-code" && !authentication.deviceAuthorizationEndpoint) {
		throw invalid("The declaration is invalid.");
	}
	if (authentication.authorizationEndpoint)
		validateEndpointReference(authentication.authorizationEndpoint, "OAuth authorization");
	if (authentication.deviceAuthorizationEndpoint)
		validateEndpointReference(authentication.deviceAuthorizationEndpoint, "Device Code");
	for (const endpoint of [
		authentication.tokenEndpoint,
		authentication.authorizationEndpoint,
		authentication.deviceAuthorizationEndpoint,
	]) {
		if (!endpoint) continue;
		const url = new URL(endpoint, baseUrl);
		if (!allowedDomains.has(url.hostname.toLowerCase())) {
			throw invalid("The declaration is invalid.");
		}
	}
	for (const path of [
		authentication.accessTokenPath,
		authentication.refreshTokenPath,
		authentication.expiresInPath,
	]) {
		if (path) validateJsonPath(path);
	}
	if (
		authentication.scopes !== undefined &&
		(!Array.isArray(authentication.scopes) ||
			authentication.scopes.length > 64 ||
			new Set(authentication.scopes).size !== authentication.scopes.length)
	) {
		throw invalid("The declaration is invalid.");
	}
	for (const scope of authentication.scopes ?? []) {
		if (typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(scope)) {
			throw invalid("The declaration is invalid.");
		}
	}
}

function validateFrontendNetwork(
	definition: ContributionDefinition,
	network: NonNullable<ContributionDefinition["frontendNetwork"]>,
): void {
	if (!isRecord(network)) throw invalid("The declaration is invalid.");
	assertExactKeys(network, ["domains", "methods", "ownerIdentifier", "requiresConsent"]);
	validateIdentifier(network.ownerIdentifier, "frontend network owner");
	if (network.ownerIdentifier !== definition.owner.identifier) {
		throw invalid("The declaration is invalid.");
	}
	if (!definition.requiredCapabilities?.includes("network.frontend")) {
		throw invalid("The declaration is invalid.");
	}
	if (
		!Array.isArray(network.domains) ||
		network.domains.length === 0 ||
		network.domains.length > 32 ||
		!Array.isArray(network.methods) ||
		network.methods.length === 0 ||
		typeof network.requiresConsent !== "boolean"
	) {
		throw invalid("The declaration is invalid.");
	}
	validateUniqueValues(network.domains, "frontend network domain");
	validateUniqueValues(network.methods, "frontend network method");
	for (const domain of network.domains) {
		if (typeof domain !== "string") throw invalid("The declaration is invalid.");
		validateDomain(domain);
	}
	for (const method of network.methods) {
		if (typeof method !== "string" || !new Set<string>(apiHttpMethods).has(method)) {
			throw invalid("The declaration is invalid.");
		}
	}
}

function validateSecretReference(reference: string): void {
	if (!/^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9_./-]{1,256}$/.test(reference)) {
		throw invalid("The declaration is invalid.");
	}
}

function validateDomain(domain: string): void {
	if (
		domain !== domain.toLowerCase() ||
		!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
		domain.endsWith(".local")
	) {
		throw invalid("The declaration is invalid.");
	}
}

function validateEndpointReference(value: string, label: string): void {
	if (
		!/^\/[A-Za-z0-9._~:/-]+$/.test(value) &&
		!/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~:/-]*)?$/.test(value)
	) {
		throw invalid(`The ${label} endpoint is invalid.`);
	}
}

function validateJsonPath(path: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
		throw invalid("The declaration is invalid.");
	}
}

function validatePositiveLimit(value: number | undefined, maximum: number, label: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
		throw invalid(`The ${label} must be between 1 and ${maximum}.`);
	}
}

function validateNonNegativeLimit(value: number | undefined, maximum: number, label: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > maximum)) {
		throw invalid(`The ${label} must be between 0 and ${maximum}.`);
	}
}

function validateEndpoint(endpoint: NonNullable<ContributionDefinition["endpoint"]>): void {
	assertKnownValue(endpoint.audience, apiAudiences, "API audience");
	assertKnownValue(endpoint.method, apiHttpMethods, "API HTTP method");
	if (
		!/^\/(?:[a-z0-9][a-z0-9._-]*|:[a-z][a-z0-9]*)(?:\/(?:[a-z0-9][a-z0-9._-]*|:[a-z][a-z0-9]*))*$/.test(
			endpoint.route,
		)
	) {
		throw invalid("The declaration is invalid.");
	}
	if (!semverPattern.test(endpoint.contractVersion)) {
		throw invalid("The declaration is invalid.");
	}
	validateIdentifier(endpoint.businessMethodIdentifier, "API business method");
	if (endpoint.requiredCapability) {
		validateIdentifier(endpoint.requiredCapability, "API permission");
	}
	if (endpoint.quota) {
		if (
			!Number.isSafeInteger(endpoint.quota.limit) ||
			endpoint.quota.limit < 1 ||
			endpoint.quota.limit > 1_000_000 ||
			!Number.isSafeInteger(endpoint.quota.windowSeconds) ||
			endpoint.quota.windowSeconds < 1 ||
			endpoint.quota.windowSeconds > 86_400
		) {
			throw invalid("The declaration is invalid.");
		}
	}
	if (endpoint.security) {
		if (!semverPattern.test(endpoint.security.policyVersion))
			throw invalid("The declaration is invalid.");
		if (
			endpoint.security.csrfRequired !== undefined &&
			typeof endpoint.security.csrfRequired !== "boolean"
		)
			throw invalid("The declaration is invalid.");
		if (
			endpoint.security.replayProtection !== undefined &&
			typeof endpoint.security.replayProtection !== "boolean"
		)
			throw invalid("The declaration is invalid.");
		validatePositiveLimit(endpoint.security.multiFactorMaximumAgeSeconds, 86_400, "MFA age");
		validatePositiveLimit(endpoint.security.maximumDepth, 32, "input depth");
		validatePositiveLimit(endpoint.security.maximumStringLength, 1_048_576, "string length");
		for (const origin of endpoint.security.allowedOrigins ?? []) {
			let parsed: URL;
			try {
				parsed = new URL(origin);
			} catch {
				throw invalid("The declaration is invalid.");
			}
			if (
				parsed.origin !== origin ||
				(parsed.protocol !== "https:" &&
					!(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)))
			)
				throw invalid("The declaration is invalid.");
		}
		for (const field of [
			...(endpoint.security.output?.omittedFields ?? []),
			...(endpoint.security.output?.maskedFields ?? []),
		])
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw invalid("The declaration is invalid.");
	}
	validateApiSchema(endpoint.input, 0);
	validateApiSchema(endpoint.output, 0);
	const errorCodes = new Set<string>();
	for (const error of endpoint.publicErrors ?? []) {
		validateIdentifier(error.code, "public error");
		if (errorCodes.has(error.code)) throw invalid("The declaration is invalid.");
		errorCodes.add(error.code);
		if (
			!Number.isSafeInteger(error.httpStatus) ||
			error.httpStatus < 400 ||
			error.httpStatus > 599
		) {
			throw invalid("The declaration is invalid.");
		}
		if (Object.keys(error.message).length === 0) {
			throw invalid("The declaration is invalid.");
		}
		validateLocalizedText(error.message);
	}
}

function validateApiSchema(
	schema: NonNullable<ContributionDefinition["endpoint"]>["input"],
	depth: number,
): void {
	if (depth > 12) throw invalid("The declaration is invalid.");
	if ("maximumLength" in schema && schema.maximumLength !== undefined) {
		if (
			schema.type !== "string" ||
			!Number.isSafeInteger(schema.maximumLength) ||
			schema.maximumLength < 1 ||
			schema.maximumLength > 1_048_576
		) {
			throw invalid("The declaration is invalid.");
		}
	}
	if (schema.type === "array") {
		if (
			schema.maximumItems !== undefined &&
			(!Number.isSafeInteger(schema.maximumItems) ||
				schema.maximumItems < 1 ||
				schema.maximumItems > 10_000)
		) {
			throw invalid("The declaration is invalid.");
		}
		validateApiSchema(schema.items, depth + 1);
	}
	if (schema.type === "object") {
		const properties = Object.keys(schema.properties);
		if (properties.length > 256) throw invalid("The declaration is invalid.");
		for (const [key, child] of Object.entries(schema.properties)) {
			validateIdentifier(key, "API field");
			validateApiSchema(child, depth + 1);
		}
		for (const required of schema.required ?? []) {
			if (!Object.hasOwn(schema.properties, required)) {
				throw invalid("The declaration is invalid.");
			}
		}
	}
}

export function toMutationCandidate(
	definition: ContributionDefinition,
	action: RegistryMutationCandidate["action"],
): RegistryMutationCandidate {
	return {
		action,
		contributionKey: contributionKey(definition.type, definition.identifier),
		ownerIdentifier: definition.owner.identifier,
		ownerKind: definition.owner.kind,
		version: definition.version,
		requiredCapabilities: [...(definition.requiredCapabilities ?? [])],
		payload: definitionAsJson(definition),
	};
}

export function compareSemver(first: string, second: string): number {
	const [firstCore, firstPrerelease] = first.split("+")[0]!.split("-", 2);
	const [secondCore, secondPrerelease] = second.split("+")[0]!.split("-", 2);
	const firstParts = firstCore!.split(".").map(Number);
	const secondParts = secondCore!.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = firstParts[index]! - secondParts[index]!;
		if (difference !== 0) return difference;
	}
	if (!firstPrerelease && !secondPrerelease) return 0;
	if (!firstPrerelease) return 1;
	if (!secondPrerelease) return -1;
	const firstIdentifiers = firstPrerelease.split(".");
	const secondIdentifiers = secondPrerelease.split(".");
	for (
		let index = 0;
		index < Math.max(firstIdentifiers.length, secondIdentifiers.length);
		index += 1
	) {
		const firstIdentifier = firstIdentifiers[index];
		const secondIdentifier = secondIdentifiers[index];
		if (firstIdentifier === undefined) return -1;
		if (secondIdentifier === undefined) return 1;
		if (firstIdentifier === secondIdentifier) continue;
		const firstNumber = /^\d+$/.test(firstIdentifier) ? Number(firstIdentifier) : undefined;
		const secondNumber = /^\d+$/.test(secondIdentifier) ? Number(secondIdentifier) : undefined;
		if (firstNumber !== undefined && secondNumber !== undefined) return firstNumber - secondNumber;
		if (firstNumber !== undefined) return -1;
		if (secondNumber !== undefined) return 1;
		return firstIdentifier.localeCompare(secondIdentifier);
	}
	return 0;
}

export function validateOwner(owner: ContributionOwner): void {
	if (!isRecord(owner)) throw invalid("The declaration is invalid.");
	if (!ownerKinds.has(owner.kind)) {
		throw invalid("The declaration is invalid.");
	}
	validateIdentifier(owner.identifier, "owner");
	if (owner.kind === "core" && owner.identifier !== "core") {
		throw invalid("The declaration is invalid.");
	}
}

function validateConfiguration(definition: ContributionDefinition): void {
	const keys = new Set<string>();
	assertOptionalArray(definition.configuration, "configurations");
	const fields = definition.configuration ?? [];
	if (fields.length > 256) throw invalid("The declaration is invalid.");
	for (const field of fields) {
		if (!isRecord(field)) throw invalid("The declaration is invalid.");
		validateIdentifier(field.key, "configuration");
		if (keys.has(field.key)) throw invalid("The declaration is invalid.");
		keys.add(field.key);
		assertJsonValue(field.defaultValue);
		validateConfigurationValue(field.defaultValue, field.type, field.key);
		assertOptionalArray(field.allowedValues, "allowed values");
		const allowedValues = field.allowedValues ?? [];
		if (allowedValues.length > 1_000) {
			throw invalid("The declaration is invalid.");
		}
		for (const value of allowedValues) {
			assertJsonValue(value);
			validateConfigurationValue(value, field.type, field.key);
		}
		const serializedAllowedValues = allowedValues.map(canonicalJson);
		validateUniqueValues(serializedAllowedValues, "configuration value");
		if (
			allowedValues.length > 0 &&
			!serializedAllowedValues.includes(canonicalJson(field.defaultValue))
		) {
			throw invalid("The declaration is invalid.");
		}
		if (!isRecord(field.description) || Object.keys(field.description).length === 0) {
			throw invalid("The declaration is invalid.");
		}
		validateLocalizedText(field.description);
	}
}

function validateTranslations(translations: ContributionDefinition["translations"]): void {
	if (!translations) return;
	if (!isRecord(translations)) throw invalid("The declaration is invalid.");
	if (Object.keys(translations).length === 0) {
		throw invalid("The declaration is invalid.");
	}
	for (const [locale, entries] of Object.entries(translations)) {
		if (!localePattern.test(locale)) throw invalid("The declaration is invalid.");
		if (!isRecord(entries)) throw invalid("The declaration is invalid.");
		if (Object.keys(entries).length === 0) {
			throw invalid("The declaration is invalid.");
		}
		for (const [key, value] of Object.entries(entries)) {
			validateIdentifier(key, "translation");
			if (!value.trim()) throw invalid("The declaration is invalid.");
		}
	}
}

function validateConfigurationValue(
	value: CoreJsonValue,
	type: ConfigurationFieldDefinition["type"],
	key: string,
): void {
	const valid =
		type === "json" ||
		(type === "boolean" && typeof value === "boolean") ||
		(type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
		(type === "number" && typeof value === "number" && Number.isFinite(value)) ||
		(["secret-reference", "string"].includes(type) && typeof value === "string");
	if (!valid) {
		throw invalid(`Configuration field ${key} has an invalid value.`);
	}
	if (type === "secret-reference" && typeof value === "string" && value !== "") {
		validateSecretReference(value);
	}
}

function canonicalJson(value: CoreJsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.entries(value)
		.sort(([first], [second]) => first.localeCompare(second))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOptionalArray(value: unknown, label: string): void {
	if (value !== undefined && !Array.isArray(value)) {
		throw invalid(`The ${label} declaration must be an array.`);
	}
}

function assertRequiredArray(value: unknown, label: string): asserts value is readonly unknown[] {
	if (!Array.isArray(value)) {
		throw invalid(`The ${label} declaration must be an array.`);
	}
}

function assertExactKeys(
	value: Readonly<Record<string, unknown>>,
	expected: readonly string[],
): void {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (
		keys.length !== sortedExpected.length ||
		keys.some((key, index) => key !== sortedExpected[index])
	) {
		throw invalid("The declaration is invalid.");
	}
}

function validateLocalizedText(value: Readonly<Record<string, string>>): void {
	if (!isRecord(value) || Object.keys(value).length === 0) {
		throw invalid("The declaration is invalid.");
	}
	for (const [locale, text] of Object.entries(value)) {
		if (!localePattern.test(locale) || typeof text !== "string" || !text.trim()) {
			throw invalid("The declaration is invalid.");
		}
	}
}

function validateIdentifier(value: string, label: string): void {
	if (typeof value !== "string" || !identifierPattern.test(value) || value.length > 160) {
		throw invalid(`The ${label} identifier is invalid.`);
	}
}

function definitionAsJson(definition: ContributionDefinition): CoreJsonValue {
	return JSON.parse(JSON.stringify(definition)) as CoreJsonValue;
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is CoreJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw invalid("The declaration is invalid.");
		return;
	}
	if (typeof value !== "object") throw invalid("The declaration is invalid.");
	if (seen.has(value)) throw invalid("The declaration is invalid.");
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) assertJsonValue(item, seen);
	} else {
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw invalid("The declaration is invalid.");
		}
		for (const item of Object.values(value as Record<string, unknown>)) {
			assertJsonValue(item, seen);
		}
	}
	seen.delete(value);
}

function invalid(message: string): RegistryError {
	return new RegistryError("registry.contract_invalid", message);
}
