import assert from "node:assert/strict";
import test from "node:test";
import { foundation } from "../backend/build/core/src/index.js";

test("expose une fondation minimale", () => {
	assert.equal(foundation.packageName, "@compendlore/core");
	assert.equal(foundation.status, "phase-3-core");
});
