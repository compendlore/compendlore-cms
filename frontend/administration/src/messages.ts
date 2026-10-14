export type AdministrationMessageKey =
	"administration.notFound.description" | "administration.notFound.title";

const englishCatalog: Readonly<Record<AdministrationMessageKey, string>> = Object.freeze({
	"administration.notFound.description":
		"This route is not registered or the session no longer has the required capability.",
	"administration.notFound.title": "Administration page unavailable",
});

const catalogs: Readonly<Record<string, Readonly<Record<AdministrationMessageKey, string>>>> =
	Object.freeze({
		fr: Object.freeze({
			"administration.notFound.description":
				"Cette route n’est pas enregistrée ou votre session ne possède plus la capacité requise.",
			"administration.notFound.title": "Page administrative indisponible",
		}),
		en: englishCatalog,
	});

export function administrationMessage(locale: string, key: AdministrationMessageKey): string {
	const normalized = locale.trim().toLowerCase();
	const language = normalized.split("-", 1)[0] || "en";
	return catalogs[normalized]?.[key] ?? catalogs[language]?.[key] ?? englishCatalog[key];
}
