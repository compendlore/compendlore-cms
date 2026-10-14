export type SiteMessageKey =
	"site.notFound.code" | "site.notFound.description" | "site.notFound.title";

const englishCatalog: Readonly<Record<SiteMessageKey, string>> = Object.freeze({
	"site.notFound.code": "Error 404",
	"site.notFound.description": "The page you tried to open does not exist.",
	"site.notFound.title": "Unknown page error",
});

const catalogs: Readonly<Record<string, Readonly<Record<SiteMessageKey, string>>>> = Object.freeze({
	fr: Object.freeze({
		"site.notFound.code": "Erreur 404",
		"site.notFound.description": "La page que vous avez essayé d’ouvrir n’existe pas.",
		"site.notFound.title": "Erreur page inconnue",
	}),
	en: englishCatalog,
});

export function siteMessage(locale: string, key: SiteMessageKey): string {
	const normalized = locale.trim().toLowerCase();
	const language = normalized.split("-", 1)[0] || "en";
	return catalogs[normalized]?.[key] ?? catalogs[language]?.[key] ?? englishCatalog[key];
}
