import { randomUUID } from "node:crypto";
import { sql, type CoreDatabase } from "../database-contracts.js";
import { CoreError } from "./errors.js";
import type { CoreJsonValue } from "./store.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([a-z][a-zA-Z0-9_]*)\s*\}\}/g;
const MANDATORY_PURPOSES = new Set(["account", "legal", "maintenance", "security"]);

export type NotificationVariableType = "boolean" | "integer" | "number" | "string";
export type NotificationVariableClassification = "internal" | "public" | "restricted";

export interface NotificationVariableDefinition {
	readonly type: NotificationVariableType;
	readonly required: boolean;
	readonly classification: NotificationVariableClassification;
	readonly maximumLength?: number;
}

export interface NotificationTemplateLocalization {
	readonly title: string;
	readonly summary?: string;
	readonly body: string;
	readonly actions?: readonly Readonly<Record<string, CoreJsonValue>>[];
}

export interface NotificationTemplateDefinition {
	readonly identifier: string;
	readonly templateVersion: string;
	readonly topicIdentifier: string;
	readonly ownerIdentifier: string;
	readonly fallbackLocale: string;
	readonly variables: Readonly<Record<string, NotificationVariableDefinition>>;
	readonly localizations: Readonly<Record<string, NotificationTemplateLocalization>>;
}

export interface RenderedNotification {
	readonly templateIdentifier: string;
	readonly templateVersion: string;
	readonly locale: string;
	readonly title: string;
	readonly summary?: string;
	readonly body: string;
	readonly actions: readonly Readonly<Record<string, CoreJsonValue>>[];
}

export interface NotificationChannelDefinition {
	readonly identifier: string;
	readonly ownerIdentifier: string;
	readonly kind: "connector" | "native";
	readonly connectorIdentifier?: string;
}

export interface NotificationPreference {
	readonly userId: string;
	readonly scopeKind: "family" | "purpose" | "topic";
	readonly scopeIdentifier: string;
	readonly channelIdentifier: string;
	readonly enabled: boolean;
	readonly locale?: string;
	readonly quietStart?: string;
	readonly quietEnd?: string;
	readonly timezone?: string;
	readonly digestFrequency?: "daily" | "hourly" | "immediate" | "weekly";
}

export interface NotificationTemplateRepository {
	registerTemplate(definition: NotificationTemplateDefinition): Promise<void>;
	findTemplate(
		identifier: string,
		version: string,
	): Promise<NotificationTemplateDefinition | undefined>;
	registerChannel(definition: NotificationChannelDefinition): Promise<void>;
	findChannel(identifier: string): Promise<NotificationChannelDefinition | undefined>;
	savePreference(preference: NotificationPreference): Promise<void>;
	findPreferences(
		userId: string,
		channelIdentifier: string,
	): Promise<readonly NotificationPreference[]>;
	materialize(input: {
		readonly messageId: string;
		readonly purpose: string;
		readonly mandatory: boolean;
		readonly rendered: RenderedNotification;
	}): Promise<string>;
}

export interface NotificationConnectorCatalog {
	hasConnector(identifier: string): Promise<boolean>;
}

export class NotificationTemplateService {
	constructor(
		private readonly repository: NotificationTemplateRepository,
		private readonly connectors: NotificationConnectorCatalog,
	) {}

	registerTemplate(definition: NotificationTemplateDefinition): Promise<void> {
		validateTemplate(definition);
		return this.repository.registerTemplate(definition);
	}

	async render(input: {
		readonly templateIdentifier: string;
		readonly templateVersion: string;
		readonly locale: string;
		readonly variables: Readonly<Record<string, CoreJsonValue>>;
	}): Promise<RenderedNotification> {
		if (!LOCALE_PATTERN.test(input.locale)) {
			throw new CoreError("configuration.invalid", "Invalid notification locale.");
		}
		const template = await this.repository.findTemplate(
			input.templateIdentifier,
			input.templateVersion,
		);
		if (!template)
			throw new CoreError(
				"messaging.topic_unknown",
				"The notification template is not registered.",
			);
		validateTemplateVariables(template.variables, input.variables);
		const locale = resolveLocale(template, input.locale);
		const localization = template.localizations[locale]!;
		return {
			templateIdentifier: template.identifier,
			templateVersion: template.templateVersion,
			locale,
			title: interpolate(localization.title, input.variables),
			...(localization.summary
				? { summary: interpolate(localization.summary, input.variables) }
				: {}),
			body: interpolate(localization.body, input.variables),
			actions: structuredClone(localization.actions ?? []),
		};
	}

	async registerChannel(definition: NotificationChannelDefinition): Promise<void> {
		validateIdentifier(definition.identifier, "channel");
		validateIdentifier(definition.ownerIdentifier, "owner");
		if (definition.kind === "native") {
			if (
				!["inbox", "realtime"].includes(definition.identifier) ||
				definition.ownerIdentifier !== "core" ||
				definition.connectorIdentifier
			) {
				throw new CoreError(
					"authorization.denied",
					"Only Core can register native notification channels.",
				);
			}
		} else {
			if (
				!definition.connectorIdentifier ||
				!(await this.connectors.hasConnector(definition.connectorIdentifier))
			) {
				throw new CoreError(
					"configuration.invalid",
					"The notification connector is not registered.",
				);
			}
		}
		await this.repository.registerChannel(definition);
	}

	async savePreference(preference: NotificationPreference): Promise<void> {
		validatePreference(preference);
		if (!(await this.repository.findChannel(preference.channelIdentifier))) {
			throw new CoreError("configuration.invalid", "The notification channel is not registered.");
		}
		await this.repository.savePreference(preference);
	}

	async resolvePreference(input: {
		readonly userId: string;
		readonly topicIdentifier: string;
		readonly familyIdentifier?: string;
		readonly purposeIdentifier: string;
		readonly channelIdentifier: string;
		readonly mandatory: boolean;
		readonly at: Date;
	}): Promise<{ readonly enabled: boolean; readonly locale?: string; readonly quiet: boolean }> {
		validateIdentifier(input.topicIdentifier, "topic");
		validateIdentifier(input.purposeIdentifier, "purpose");
		validateIdentifier(input.channelIdentifier, "channel");
		if (input.familyIdentifier) validateIdentifier(input.familyIdentifier, "family");
		if (Number.isNaN(input.at.getTime()))
			throw new CoreError("configuration.invalid", "Invalid notification evaluation date.");
		const preferences = await this.repository.findPreferences(
			input.userId,
			input.channelIdentifier,
		);
		const preference =
			preferences.find(
				(item) => item.scopeKind === "topic" && item.scopeIdentifier === input.topicIdentifier,
			) ??
			preferences.find(
				(item) => item.scopeKind === "family" && item.scopeIdentifier === input.familyIdentifier,
			) ??
			preferences.find(
				(item) => item.scopeKind === "purpose" && item.scopeIdentifier === input.purposeIdentifier,
			);
		const quiet = preference ? isQuiet(preference, input.at) : false;
		const mandatory = input.mandatory || MANDATORY_PURPOSES.has(input.purposeIdentifier);
		return {
			enabled: mandatory || (preference?.enabled ?? true),
			...(preference?.locale ? { locale: preference.locale } : {}),
			quiet: mandatory ? false : quiet,
		};
	}

	async materialize(input: {
		readonly messageId: string;
		readonly purpose: string;
		readonly mandatory: boolean;
		readonly rendered: RenderedNotification;
	}): Promise<string> {
		validateUuid(input.messageId, "message");
		validateIdentifier(input.purpose, "purpose");
		return this.repository.materialize({
			...input,
			mandatory: input.mandatory || MANDATORY_PURPOSES.has(input.purpose),
		});
	}
}

export class InMemoryNotificationTemplateRepository implements NotificationTemplateRepository {
	private readonly templates = new Map<string, NotificationTemplateDefinition>();
	private readonly channels = new Map<string, NotificationChannelDefinition>([
		["inbox", { identifier: "inbox", ownerIdentifier: "core", kind: "native" }],
		["realtime", { identifier: "realtime", ownerIdentifier: "core", kind: "native" }],
	]);
	private readonly preferences = new Map<string, NotificationPreference>();
	private readonly notifications = new Map<
		string,
		{
			readonly purpose: string;
			readonly mandatory: boolean;
			readonly rendered: RenderedNotification;
		}
	>();

	async registerTemplate(definition: NotificationTemplateDefinition): Promise<void> {
		const key = `${definition.identifier}@${definition.templateVersion}`;
		const current = this.templates.get(key);
		if (current && stableJson(current) !== stableJson(definition)) {
			throw new CoreError(
				"infrastructure.conflict",
				"The notification template version is immutable.",
			);
		}
		this.templates.set(key, structuredClone(definition));
	}

	async findTemplate(
		identifier: string,
		version: string,
	): Promise<NotificationTemplateDefinition | undefined> {
		const value = this.templates.get(`${identifier}@${version}`);
		return value ? structuredClone(value) : undefined;
	}

	async registerChannel(definition: NotificationChannelDefinition): Promise<void> {
		const current = this.channels.get(definition.identifier);
		if (current && stableJson(current) !== stableJson(definition)) {
			throw new CoreError(
				"infrastructure.conflict",
				"The notification channel belongs to another definition.",
			);
		}
		this.channels.set(definition.identifier, structuredClone(definition));
	}

	async findChannel(identifier: string): Promise<NotificationChannelDefinition | undefined> {
		const channel = this.channels.get(identifier);
		return channel ? structuredClone(channel) : undefined;
	}

	async savePreference(preference: NotificationPreference): Promise<void> {
		this.preferences.set(preferenceKey(preference), structuredClone(preference));
	}

	async findPreferences(
		userId: string,
		channelIdentifier: string,
	): Promise<readonly NotificationPreference[]> {
		return [...this.preferences.values()]
			.filter((item) => item.userId === userId && item.channelIdentifier === channelIdentifier)
			.map((item) => structuredClone(item));
	}

	async materialize(input: {
		readonly messageId: string;
		readonly purpose: string;
		readonly mandatory: boolean;
		readonly rendered: RenderedNotification;
	}): Promise<string> {
		const current = this.notifications.get(input.messageId);
		const snapshot = {
			purpose: input.purpose,
			mandatory: input.mandatory,
			rendered: input.rendered,
		};
		if (current && stableJson(current) !== stableJson(snapshot)) {
			throw new CoreError("infrastructure.conflict", "The rendered notification is immutable.");
		}
		this.notifications.set(input.messageId, structuredClone(snapshot));
		return input.messageId;
	}
}

interface TemplateRow {
	readonly [key: string]: unknown;
	readonly identifier: string;
	readonly template_version: string;
	readonly topic_identifier: string;
	readonly owner_identifier: string;
	readonly fallback_locale: string;
	readonly variable_definitions: Readonly<Record<string, NotificationVariableDefinition>>;
}

interface LocalizationRow {
	readonly [key: string]: unknown;
	readonly locale: string;
	readonly title: string;
	readonly summary: string | null;
	readonly body: string;
	readonly actions: readonly Readonly<Record<string, CoreJsonValue>>[];
}

export class PostgresNotificationTemplateRepository implements NotificationTemplateRepository {
	constructor(private readonly database: CoreDatabase) {}

	async registerTemplate(definition: NotificationTemplateDefinition): Promise<void> {
		await this.database.transaction(async (transaction) => {
			const template = await transaction.query(/* pgsql */ sql`
				INSERT INTO core.messaging_templates (
					identifier, template_version, topic_identifier, owner_identifier,
					fallback_locale, variable_definitions
				)
				VALUES (
					${definition.identifier}, ${definition.templateVersion}, ${definition.topicIdentifier},
					${definition.ownerIdentifier}, ${definition.fallbackLocale},
					${JSON.stringify(definition.variables)}::jsonb
				)
				ON CONFLICT (identifier, template_version) DO UPDATE
				SET identifier = core.messaging_templates.identifier
				WHERE
					core.messaging_templates.topic_identifier = excluded.topic_identifier
					AND core.messaging_templates.owner_identifier = excluded.owner_identifier
					AND core.messaging_templates.fallback_locale = excluded.fallback_locale
					AND core.messaging_templates.variable_definitions = excluded.variable_definitions
				RETURNING identifier
			`);
			if (template.rowCount !== 1)
				throw new CoreError(
					"infrastructure.conflict",
					"The notification template version is immutable.",
				);
			for (const [locale, content] of Object.entries(definition.localizations)) {
				const localization = await transaction.query(/* pgsql */ sql`
					INSERT INTO core.messaging_template_localizations (
						template_identifier, template_version, locale, title, summary, body, actions
					)
					VALUES (
						${definition.identifier}, ${definition.templateVersion}, ${locale},
						${content.title}, ${content.summary ?? null}, ${content.body},
						${JSON.stringify(content.actions ?? [])}::jsonb
					)
					ON CONFLICT (template_identifier, template_version, locale) DO UPDATE
					SET locale = core.messaging_template_localizations.locale
					WHERE
						core.messaging_template_localizations.title = excluded.title
						AND core.messaging_template_localizations.summary IS NOT DISTINCT FROM excluded.summary
						AND core.messaging_template_localizations.body = excluded.body
						AND core.messaging_template_localizations.actions = excluded.actions
					RETURNING locale
				`);
				if (localization.rowCount !== 1)
					throw new CoreError(
						"infrastructure.conflict",
						"The notification template localization is immutable.",
					);
			}
		});
	}

	async findTemplate(
		identifier: string,
		version: string,
	): Promise<NotificationTemplateDefinition | undefined> {
		const template = await this.database.query<TemplateRow>(/* pgsql */ sql`
			SELECT identifier, template_version, topic_identifier, owner_identifier,
				fallback_locale, variable_definitions
			FROM core.messaging_templates
			WHERE identifier = ${identifier} AND template_version = ${version} AND active = true
		`);
		const row = template.rows[0];
		if (!row) return undefined;
		const contents = await this.database.query<LocalizationRow>(/* pgsql */ sql`
			SELECT locale, title, summary, body, actions
			FROM core.messaging_template_localizations
			WHERE template_identifier = ${identifier} AND template_version = ${version}
		`);
		return {
			identifier: row.identifier,
			templateVersion: row.template_version,
			topicIdentifier: row.topic_identifier,
			ownerIdentifier: row.owner_identifier,
			fallbackLocale: row.fallback_locale,
			variables: row.variable_definitions,
			localizations: Object.fromEntries(
				contents.rows.map((content) => [
					content.locale,
					{
						title: content.title,
						...(content.summary ? { summary: content.summary } : {}),
						body: content.body,
						actions: content.actions,
					},
				]),
			),
		};
	}

	async registerChannel(definition: NotificationChannelDefinition): Promise<void> {
		const result = await this.database.query(/* pgsql */ sql`
			INSERT INTO core.messaging_channels (identifier, owner_identifier, kind, connector_identifier)
			VALUES (${definition.identifier}, ${definition.ownerIdentifier}, ${definition.kind}, ${definition.connectorIdentifier ?? null})
			ON CONFLICT (identifier) DO UPDATE
			SET active = true, updated_at = now()
			WHERE
				core.messaging_channels.owner_identifier = excluded.owner_identifier
				AND core.messaging_channels.kind = excluded.kind
				AND core.messaging_channels.connector_identifier IS NOT DISTINCT FROM excluded.connector_identifier
			RETURNING identifier
		`);
		if (result.rowCount !== 1)
			throw new CoreError(
				"infrastructure.conflict",
				"The notification channel belongs to another definition.",
			);
	}

	async findChannel(identifier: string): Promise<NotificationChannelDefinition | undefined> {
		const result = await this.database.query<{
			readonly [key: string]: unknown;
			readonly identifier: string;
			readonly owner_identifier: string;
			readonly kind: "connector" | "native";
			readonly connector_identifier: string | null;
		}>(/* pgsql */ sql`
			SELECT identifier, owner_identifier, kind, connector_identifier
			FROM core.messaging_channels
			WHERE identifier = ${identifier} AND active = true
		`);
		const row = result.rows[0];
		return row
			? {
					identifier: row.identifier,
					ownerIdentifier: row.owner_identifier,
					kind: row.kind,
					...(row.connector_identifier ? { connectorIdentifier: row.connector_identifier } : {}),
				}
			: undefined;
	}

	async savePreference(preference: NotificationPreference): Promise<void> {
		await this.database.query(/* pgsql */ sql`
			INSERT INTO core.notification_channel_preferences (
				user_id, scope_kind, scope_identifier, channel_identifier, enabled, locale,
				quiet_start, quiet_end, timezone, digest_frequency, updated_at
			)
			VALUES (
				${preference.userId}, ${preference.scopeKind}, ${preference.scopeIdentifier},
				${preference.channelIdentifier}, ${preference.enabled}, ${preference.locale ?? null},
				${preference.quietStart ?? null}, ${preference.quietEnd ?? null},
				${preference.timezone ?? null}, ${preference.digestFrequency ?? null}, now()
			)
			ON CONFLICT (user_id, scope_kind, scope_identifier, channel_identifier) DO UPDATE
			SET enabled = excluded.enabled, locale = excluded.locale, quiet_start = excluded.quiet_start,
				quiet_end = excluded.quiet_end, timezone = excluded.timezone,
				digest_frequency = excluded.digest_frequency, updated_at = excluded.updated_at
		`);
	}

	async findPreferences(
		userId: string,
		channelIdentifier: string,
	): Promise<readonly NotificationPreference[]> {
		const result = await this.database.query<{
			readonly [key: string]: unknown;
			readonly scope_kind: NotificationPreference["scopeKind"];
			readonly scope_identifier: string;
			readonly enabled: boolean;
			readonly locale: string | null;
			readonly quiet_start: string | null;
			readonly quiet_end: string | null;
			readonly timezone: string | null;
			readonly digest_frequency: NotificationPreference["digestFrequency"] | null;
		}>(/* pgsql */ sql`
			SELECT scope_kind, scope_identifier, enabled, locale, quiet_start, quiet_end, timezone, digest_frequency
			FROM core.notification_channel_preferences
			WHERE user_id = ${userId} AND channel_identifier = ${channelIdentifier}
		`);
		return result.rows.map((row) => ({
			userId,
			channelIdentifier,
			scopeKind: row.scope_kind,
			scopeIdentifier: row.scope_identifier,
			enabled: row.enabled,
			...(row.locale ? { locale: row.locale } : {}),
			...(row.quiet_start ? { quietStart: row.quiet_start } : {}),
			...(row.quiet_end ? { quietEnd: row.quiet_end } : {}),
			...(row.timezone ? { timezone: row.timezone } : {}),
			...(row.digest_frequency ? { digestFrequency: row.digest_frequency } : {}),
		}));
	}

	async materialize(input: {
		readonly messageId: string;
		readonly purpose: string;
		readonly mandatory: boolean;
		readonly rendered: RenderedNotification;
	}): Promise<string> {
		const notificationId = randomUUID();
		const result = await this.database.query<{ readonly id: string }>(/* pgsql */ sql`
			INSERT INTO core.notifications (
				id, message_id, template_identifier, template_version, rendered_content,
				rendered_locale, purpose, mandatory
			)
			VALUES (
				${notificationId}, ${input.messageId}, ${input.rendered.templateIdentifier},
				${input.rendered.templateVersion}, ${JSON.stringify(input.rendered)}::jsonb,
				${input.rendered.locale}, ${input.purpose}, ${input.mandatory}
			)
			ON CONFLICT (message_id) DO UPDATE
			SET id = core.notifications.id
			WHERE
				core.notifications.template_identifier = excluded.template_identifier
				AND core.notifications.template_version = excluded.template_version
				AND core.notifications.rendered_content = excluded.rendered_content
				AND core.notifications.rendered_locale = excluded.rendered_locale
				AND core.notifications.purpose = excluded.purpose
				AND core.notifications.mandatory = excluded.mandatory
			RETURNING id
		`);
		if (!result.rows[0])
			throw new CoreError("infrastructure.conflict", "The rendered notification is immutable.");
		return result.rows[0].id;
	}
}

function validateTemplate(definition: NotificationTemplateDefinition): void {
	validateIdentifier(definition.identifier, "template");
	validateIdentifier(definition.topicIdentifier, "topic");
	validateIdentifier(definition.ownerIdentifier, "owner");
	if (
		!/^\d+\.\d+\.\d+$/.test(definition.templateVersion) ||
		!LOCALE_PATTERN.test(definition.fallbackLocale) ||
		!definition.localizations[definition.fallbackLocale]
	)
		throw new CoreError(
			"configuration.invalid",
			"Invalid notification template version or fallback locale.",
		);
	for (const [name, variable] of Object.entries(definition.variables)) {
		if (
			!/^[a-z][a-zA-Z0-9_]*$/.test(name) ||
			!["boolean", "integer", "number", "string"].includes(variable.type) ||
			!["internal", "public", "restricted"].includes(variable.classification) ||
			(variable.maximumLength !== undefined &&
				(!Number.isSafeInteger(variable.maximumLength) ||
					variable.maximumLength < 1 ||
					variable.maximumLength > 10_000))
		)
			throw new CoreError("configuration.invalid", "Invalid notification template variable.");
	}
	for (const [locale, content] of Object.entries(definition.localizations)) {
		if (!LOCALE_PATTERN.test(locale) || !content.title.trim() || !content.body.trim())
			throw new CoreError("configuration.invalid", "Invalid notification template localization.");
		for (const placeholder of placeholders([content.title, content.summary ?? "", content.body]))
			if (!definition.variables[placeholder])
				throw new CoreError(
					"configuration.invalid",
					"The notification template uses an undeclared variable.",
				);
	}
}

function validateTemplateVariables(
	definitions: Readonly<Record<string, NotificationVariableDefinition>>,
	values: Readonly<Record<string, CoreJsonValue>>,
): void {
	for (const key of Object.keys(values))
		if (!definitions[key])
			throw new CoreError(
				"configuration.invalid",
				"The notification contains an unknown variable.",
			);
	for (const [name, definition] of Object.entries(definitions)) {
		const value = values[name];
		if (value === undefined) {
			if (definition.required)
				throw new CoreError(
					"configuration.invalid",
					"The notification is missing a required variable.",
				);
			continue;
		}
		const valid =
			definition.type === "integer"
				? Number.isSafeInteger(value)
				: definition.type === "number"
					? typeof value === "number" && Number.isFinite(value)
					: typeof value === definition.type;
		if (
			!valid ||
			(typeof value === "string" &&
				definition.maximumLength !== undefined &&
				value.length > definition.maximumLength)
		)
			throw new CoreError(
				"configuration.invalid",
				"The notification contains an invalid variable.",
			);
	}
}

function resolveLocale(template: NotificationTemplateDefinition, requested: string): string {
	if (template.localizations[requested]) return requested;
	const language = requested.split("-")[0]!;
	if (template.localizations[language]) return language;
	return template.fallbackLocale;
}

function interpolate(source: string, values: Readonly<Record<string, CoreJsonValue>>): string {
	return source.replace(PLACEHOLDER_PATTERN, (_match, name: string) =>
		escapeText(String(values[name] ?? "")),
	);
}

function escapeText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function placeholders(contents: readonly string[]): readonly string[] {
	return contents.flatMap((content) =>
		[...content.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!),
	);
}

function validatePreference(preference: NotificationPreference): void {
	if (
		!isUuid(preference.userId) ||
		!IDENTIFIER_PATTERN.test(preference.scopeIdentifier) ||
		!IDENTIFIER_PATTERN.test(preference.channelIdentifier) ||
		(preference.locale && !LOCALE_PATTERN.test(preference.locale))
	)
		throw new CoreError("configuration.invalid", "Invalid notification preference.");
	const quietFields = [preference.quietStart, preference.quietEnd, preference.timezone];
	if (quietFields.some(Boolean) && !quietFields.every(Boolean))
		throw new CoreError("configuration.invalid", "Incomplete notification quiet hours.");
	if (
		preference.quietStart &&
		(!isClockTime(preference.quietStart) || !isClockTime(preference.quietEnd!))
	)
		throw new CoreError("configuration.invalid", "Invalid notification quiet hours.");
}

function isQuiet(preference: NotificationPreference, at: Date): boolean {
	if (!preference.quietStart || !preference.quietEnd || !preference.timezone) return false;
	let current: string;
	try {
		current = new Intl.DateTimeFormat("en-GB", {
			timeZone: preference.timezone,
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(at);
	} catch {
		throw new CoreError("configuration.invalid", "Invalid notification preference timezone.");
	}
	return preference.quietStart <= preference.quietEnd
		? current >= preference.quietStart && current < preference.quietEnd
		: current >= preference.quietStart || current < preference.quietEnd;
}

function validateIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_PATTERN.test(value) || value.length > 160)
		throw new CoreError("configuration.invalid", `Invalid notification ${label} identifier.`);
}

function validateUuid(value: string, label: string): void {
	if (!isUuid(value))
		throw new CoreError("configuration.invalid", `Invalid notification ${label} identifier.`);
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isClockTime(value: string): boolean {
	return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function preferenceKey(preference: NotificationPreference): string {
	return `${preference.userId}:${preference.scopeKind}:${preference.scopeIdentifier}:${preference.channelIdentifier}`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
