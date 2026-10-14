import { CoreError } from "./errors.js";
import type {
	CoreEmailAddress,
	CoreRole,
	CoreStore,
	CoreUser,
	TwoFactorRegistration,
} from "./store.js";

export interface CoreRestorationBundle {
	readonly users: readonly CoreUser[];
	readonly emails: readonly CoreEmailAddress[];
	readonly roles: readonly CoreRole[];
	readonly userCapabilities: readonly {
		readonly userId: string;
		readonly capability: string;
	}[];
	readonly roleCapabilities: readonly {
		readonly roleId: string;
		readonly capability: string;
	}[];
	readonly userRoles: readonly { readonly userId: string; readonly roleId: string }[];
	readonly capabilityImplications: readonly {
		readonly capability: string;
		readonly impliedCapability: string;
	}[];
	readonly roleIncompatibilities: readonly {
		readonly firstRoleId: string;
		readonly secondRoleId: string;
	}[];
	readonly twoFactor: readonly {
		readonly userId: string;
		readonly registration: TwoFactorRegistration;
	}[];
}

export class CoreRestorationService {
	constructor(private readonly store: CoreStore) {}

	async restore(bundle: CoreRestorationBundle): Promise<void> {
		validateBundle(bundle);
		await this.store.transaction(async () => {
			if ((await this.store.countUsers()) !== 0) {
				throw new CoreError("lifecycle.invalid_state", "The resource is in an invalid state.");
			}
			for (const user of bundle.users) await this.store.createUser(user);
			for (const email of bundle.emails) await this.store.upsertEmailAddress(email);
			for (const role of bundle.roles) await this.store.createRole(role);
			for (const grant of bundle.userCapabilities) {
				await this.store.grantCapability(grant.userId, grant.capability);
			}
			for (const grant of bundle.roleCapabilities) {
				await this.store.grantRoleCapability(grant.roleId, grant.capability);
			}
			for (const assignment of bundle.userRoles) {
				await this.store.assignRole(assignment.userId, assignment.roleId);
			}
			for (const implication of bundle.capabilityImplications) {
				await this.store.declareCapabilityImplication(
					implication.capability,
					implication.impliedCapability,
				);
			}
			for (const incompatibility of bundle.roleIncompatibilities) {
				await this.store.declareRoleIncompatibility(
					incompatibility.firstRoleId,
					incompatibility.secondRoleId,
				);
			}
			for (const registration of bundle.twoFactor) {
				await this.store.setTwoFactor(registration.userId, registration.registration);
			}
		});
	}
}

function validateBundle(bundle: CoreRestorationBundle): void {
	const userIds = new Set(bundle.users.map((user) => user.id));
	const roleIds = new Set(bundle.roles.map((role) => role.id));
	if (userIds.size !== bundle.users.length || roleIds.size !== bundle.roles.length) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	if (bundle.users.filter((user) => user.founder).length > 1) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
	if (
		bundle.emails.some((email) => !userIds.has(email.userId)) ||
		bundle.userCapabilities.some((grant) => !userIds.has(grant.userId)) ||
		bundle.roleCapabilities.some((grant) => !roleIds.has(grant.roleId)) ||
		bundle.userRoles.some(
			(assignment) => !userIds.has(assignment.userId) || !roleIds.has(assignment.roleId),
		) ||
		bundle.twoFactor.some((registration) => !userIds.has(registration.userId)) ||
		bundle.roleIncompatibilities.some(
			(incompatibility) =>
				!roleIds.has(incompatibility.firstRoleId) || !roleIds.has(incompatibility.secondRoleId),
		)
	) {
		throw new CoreError("configuration.invalid", "Invalid configuration.");
	}
}
