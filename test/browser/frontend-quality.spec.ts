import { expect, test, type Page } from "@playwright/test";

const viewports = [
	{ name: "wide-desktop", width: 1920, height: 1080, columns: 3 },
	{ name: "desktop", width: 1440, height: 900, columns: 3 },
	{ name: "compact-desktop", width: 1024, height: 768, columns: 2 },
	{ name: "tablet", width: 768, height: 1024, columns: 2 },
	{ name: "mobile", width: 375, height: 812, columns: 1 },
] as const;

for (const viewport of viewports) {
	test(`préserve le rendu ${viewport.name} sans débordement`, async ({ page }) => {
		await captureConsoleErrors(page);
		await page.setViewportSize(viewport);
		await page.goto("/?design-system=1");
		await expect(page.getByRole("heading", { name: "DESIGN SYSTEM PARTAGÉ" })).toBeVisible();
		await expect(page.getByRole("banner")).toBeVisible();

		const geometry = await page.evaluate(() => {
			const grid = document.querySelector<HTMLElement>(".content-grid");
			const cards = [...document.querySelectorAll<HTMLElement>(".content-grid > .card")];
			const topbar = document.querySelector<HTMLElement>(".topbar");
			const pageContent = document.querySelector<HTMLElement>(".page-content");
			const contentWrap = document.querySelector<HTMLElement>(".content-wrap");
			const actionCard = cards[0];
			if (!grid || !topbar || !pageContent || !contentWrap || !actionCard)
				throw new Error("The frontend quality fixture is incomplete.");
			const actionBounds = actionCard.getBoundingClientRect();
			const pageBounds = pageContent.getBoundingClientRect();
			const contentBounds = contentWrap.getBoundingClientRect();
			const actionButtons = [...actionCard.querySelectorAll<HTMLElement>("button")];
			return {
				bodyWidth: document.body.scrollWidth,
				documentWidth: document.documentElement.scrollWidth,
				viewportWidth: window.innerWidth,
				columnCount: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)))
					.size,
				gridDisplay: getComputedStyle(grid).display,
				topbarPosition: getComputedStyle(topbar).position,
				fullPageContent:
					Math.abs(contentBounds.left - pageBounds.left) <= 1 &&
					Math.abs(contentBounds.right - pageBounds.right) <= 1,
				actionContentFits: actionButtons.every((button) => {
					const bounds = button.getBoundingClientRect();
					return bounds.left >= actionBounds.left && bounds.right <= actionBounds.right;
				}),
			};
		});
		expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.columnCount).toBe(viewport.columns);
		expect(geometry.gridDisplay).toBe("grid");
		expect(geometry.fullPageContent).toBe(true);
		expect(geometry.actionContentFits).toBe(true);
		expect(`${JSON.stringify(geometry, null, "\t")}\n`).toMatchSnapshot(
			`${viewport.name}.visual.json`,
		);
	});
}

test("préserve le clavier, la réduction de mouvement et les ressources publiques", async ({
	page,
}) => {
	const errors = await captureConsoleErrors(page);
	const resources: string[] = [];
	page.on("request", (request) => resources.push(request.url()));
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/?design-system=1");

	await page.keyboard.press("Tab");
	await expect(page.getByRole("link", { name: "Compendlore CMS" })).toBeFocused();
	const focusOutline = await page
		.getByRole("link", { name: "Compendlore CMS" })
		.evaluate((element) => {
			const style = getComputedStyle(element);
			return { style: style.outlineStyle, width: style.outlineWidth };
		});
	expect(focusOutline.style).not.toBe("none");
	expect(focusOutline.width).not.toBe("0px");

	await page.getByRole("button", { name: "Ouvrir la modale" }).click();
	await expect(page.getByRole("dialog", { name: "Modale accessible" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Modale accessible" })).toBeHidden();

	const reducedMotionSeconds = await page.evaluate(() => {
		const element = document.createElement("div");
		element.className = "loading-screen__spinner";
		document.body.append(element);
		const duration = getComputedStyle(element).animationDuration;
		element.remove();
		return duration.endsWith("ms")
			? Number.parseFloat(duration) / 1000
			: Number.parseFloat(duration);
	});
	expect(reducedMotionSeconds).toBeLessThanOrEqual(0.00001);
	expect(resources.some((url) => url.includes("/administration/"))).toBe(false);
	expect(errors).toEqual([]);
});

test("redirige l’administration avant de livrer son entrée frontend", async ({ page }) => {
	const resources: string[] = [];
	page.on("request", (request) => resources.push(request.url()));
	const response = await page.goto("/admin");
	expect(response?.url()).toBe("http://127.0.0.1:5173/");
	expect(resources.some((url) => url.includes("/administration/"))).toBe(false);
	await expect(page.getByRole("heading", { name: "COMPENDLORE CMS" })).toBeVisible();
});

test("affiche la validation de sécurité puis révoque tous les onglets administratifs", async ({
	context,
	page,
}) => {
	const secondPage = await context.newPage();
	const firstErrors = await captureConsoleErrors(page);
	const secondErrors = await captureConsoleErrors(secondPage);
	const preview = "/admin?administration-preview=1&shell-security=1";
	await Promise.all([page.goto(preview), secondPage.goto(preview)]);
	await expect(page.getByRole("heading", { name: "Sécurité et notifications" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Notifications non lues (1)" })).toBeVisible();
	await expect(
		secondPage.getByRole("button", { name: "Notifications non lues (1)" }),
	).toBeVisible();
	await page.evaluate(() => {
		for (let index = 0; index < 7; index += 1) {
			window.compendloreNotifications?.push({
				id: `console-${index}`,
				title: `Console notification ${index + 1}`,
				message: "Injected from the browser console.",
				presentation: "toast",
				tone: "information",
				occurredAt: new Date().toISOString(),
				read: false,
				displayDurationMs: 60_000,
			});
		}
	});
	await expect(page.getByRole("button", { name: "Notifications non lues (8)" })).toBeVisible();
	await expect(page.locator(".notification-float")).toHaveCount(3);
	const desktopNotificationLayout = await page
		.locator(".notification-float")
		.first()
		.evaluate((frame) => {
			const title = frame.querySelector<HTMLElement>(".notification-frame__title");
			const time = frame.querySelector<HTMLElement>(".notification-frame__time");
			const message = frame.querySelector<HTMLElement>(".notification-frame__message");
			if (!title || !time || !message) throw new Error("The notification frame is incomplete.");
			const titleBounds = title.getBoundingClientRect();
			const timeBounds = time.getBoundingClientRect();
			const messageBounds = message.getBoundingClientRect();
			return {
				titleBeforeTime: titleBounds.left < timeBounds.left,
				messageBelowHeader: messageBounds.top >= Math.max(titleBounds.bottom, timeBounds.bottom),
			};
		});
	expect(desktopNotificationLayout).toEqual({ titleBeforeTime: true, messageBelowHeader: true });
	await page.getByRole("button", { name: "Notifications non lues (8)" }).click();
	await expect(page.getByRole("region", { name: "Centre de notifications" })).toBeVisible();
	await expect(page.locator("#notification-panel li")).toHaveCount(5);
	await page.getByRole("button", { name: "Tout marquer comme lu" }).click();
	await expect(page.locator(".notification-bell")).toHaveCount(0);
	await page.evaluate(() =>
		window.compendloreNotifications?.push({
			id: "mobile-layout",
			title: "Mobile notification",
			message: "The time is placed below this message.",
			presentation: "toast",
			tone: "information",
			occurredAt: new Date().toISOString(),
			read: false,
			displayDurationMs: 60_000,
		}),
	);
	await page.setViewportSize({ width: 375, height: 812 });
	const mobileNotificationLayout = await page
		.locator(".notification-float")
		.first()
		.evaluate((frame) => {
			const time = frame.querySelector<HTMLElement>(".notification-frame__time");
			const message = frame.querySelector<HTMLElement>(".notification-frame__message");
			if (!time || !message) throw new Error("The mobile notification frame is incomplete.");
			const frameBounds = frame.getBoundingClientRect();
			const timeBounds = time.getBoundingClientRect();
			const messageBounds = message.getBoundingClientRect();
			return {
				timeBelowMessage: timeBounds.top >= messageBounds.bottom,
				timeAlignedLeft: Math.abs(timeBounds.left - frameBounds.left) < 24,
			};
		});
	expect(mobileNotificationLayout).toEqual({ timeBelowMessage: true, timeAlignedLeft: true });
	await page.getByRole("button", { name: "Simuler la révocation" }).click();
	await expect(page).toHaveURL("http://127.0.0.1:5173/");
	await expect(secondPage).toHaveURL("http://127.0.0.1:5173/");
	expect(firstErrors).toEqual([]);
	expect(secondErrors).toEqual([]);
});

test("déploie les menus principal et latéral sur une taille réduite", async ({ page }) => {
	const errors = await captureConsoleErrors(page);
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto("/?compact-navigation=1");
	await expect(page.getByRole("heading", { name: "NAVIGATION COMPACTE" })).toBeVisible();

	const mainToggle = page.getByRole("button", { name: "Ouvrir le menu principal" });
	const mainNavigation = page.getByRole("navigation", { name: "Navigation principale" });
	await expect(mainToggle).toBeVisible();
	await expect(mainNavigation).toBeHidden();
	await mainToggle.click();
	await expect(page.getByRole("button", { name: "Fermer le menu principal" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(mainNavigation).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Bibliothèque Parcourir les contenus" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Compte utilisateur" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(mainNavigation).toBeHidden();
	await expect(mainToggle).toBeFocused();

	await mainToggle.click();
	await page.getByRole("main").dispatchEvent("pointerdown");
	await expect(mainNavigation).toBeHidden();
	await mainToggle.click();
	await page.getByRole("link", { name: "Bibliothèque Parcourir les contenus" }).click();
	await expect(mainNavigation).toBeHidden();

	const sidebarToggle = page.getByRole("button", { name: "Ouvrir le menu latéral" });
	const sidebarNavigation = page.getByRole("navigation", { name: "Navigation du site" });
	await expect(sidebarToggle).toBeVisible();
	await expect(sidebarNavigation).toBeHidden();
	await sidebarToggle.click();
	await expect(sidebarNavigation).toBeVisible();
	await expect(page.getByRole("link", { name: "Lien 1" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Lien 2" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Lien 3" })).toBeVisible();
	await expect(page.getByRole("separator", { name: "Collection" })).toBeVisible();
	await expect(page.getByText("Catégorie 1", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Lien 4" })).toBeVisible();

	const mobileGeometry = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: window.innerWidth,
	}));
	expect(mobileGeometry.documentWidth).toBeLessThanOrEqual(mobileGeometry.viewportWidth);

	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(sidebarToggle).toBeHidden();
	await expect(mainToggle).toBeHidden();
	await expect(mainNavigation).toBeVisible();
	await expect(sidebarNavigation).toBeVisible();
	expect(errors).toEqual([]);
});

async function captureConsoleErrors(page: Page): Promise<string[]> {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}
