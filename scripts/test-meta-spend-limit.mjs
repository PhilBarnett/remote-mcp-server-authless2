import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { after } from "node:test";
const bundle = await build({
	entryPoints: ["src/tools/meta-spend-limit.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	target: "es2022",
});
const dir = await mkdtemp(tmpdir() + "/meta-limit-test-");
after(() => rm(dir, { recursive: true, force: true }));
await writeFile(dir + "/bundle.mjs", bundle.outputFiles[0].text);
const { manageMetaSpendLimit: manage, metaSpendLimitSchema: schema } = await import(
	pathToFileURL(dir + "/bundle.mjs").href
);
function setup() {
	const account = {
		id: "act_123",
		account_id: "123",
		name: "Blindmotion",
		currency: "AUD",
		timezone_name: "Australia/Sydney",
		account_status: 1,
		disable_reason: 0,
		spend_cap: "100000",
		amount_spent: "85000",
	};
	let time = Date.parse("2026-10-20T12:00:00Z");
	const calls = [];
	const deps = {
		now: () => time,
		getConfig: () => ({ adAccountId: "act_123", accessToken: "private-test-secret" }),
		get: async (path, params) => {
			calls.push({ method: "GET", path, params });
			return structuredClone(
				path.endsWith("/insights") ? { data: [{ spend: "700.00" }] } : account,
			);
		},
		post: async (path, params) => {
			calls.push({ method: "POST", path, params });
			account.spend_cap = params.spend_cap;
			return { success: true };
		},
	};
	const run = (a) => manage(deps, a);
	const writes = () => calls.filter((c) => c.method === "POST");
	return { account, deps, run, calls, writes, advance: (ms) => (time += ms) };
}
const change = { expected_account_name: "Blindmotion", new_limit_aud: 2500.12 };
async function preview(s) {
	return s.run({ mode: "preview", ...change });
}
function apply(p, edits = {}) {
	return {
		mode: "apply",
		...change,
		preview_token: p.preview_token,
		confirmation: "CONFIRM META ACCOUNT SPEND LIMIT CHANGE",
		...edits,
	};
}
test("read converts cents, shows status/timezone, computes local complete days and warns before exhaustion", async () => {
	const s = setup(),
		r = await s.run({ mode: "read" });
	assert.equal(r.account_limit_aud, 1000);
	assert.equal(r.spend_counted_against_limit_aud, 850);
	assert.equal(r.remaining_allowance_aud, 150);
	assert.equal(r.warning, "APPROACHING_LIMIT");
	assert.equal(r.account_status, "ACTIVE");
	assert.equal(r.estimated_days_remaining, 1.5);
	assert.equal(r.last_7_complete_days.since, "2026-10-13");
	assert.equal(r.last_7_complete_days.until, "2026-10-19");
	assert.equal(s.writes().length, 0);
	s.account.amount_spent = "100001";
	assert.equal((await s.run({ mode: "read" })).warning, "EXHAUSTED");
	s.account.spend_cap = "0";
	const unlimited = await s.run({ mode: "read" });
	assert.equal(unlimited.warning, "NO_ACCOUNT_LIMIT");
	assert.equal(unlimited.remaining_allowance_aud, null);
	delete s.account.spend_cap;
	assert.equal((await s.run({ mode: "read" })).warning, "UNKNOWN");
});
test("preview never writes; exact approval writes only finite spend_cap in cents and verifies it", async () => {
	const s = setup(),
		p = await preview(s);
	assert.equal(s.writes().length, 0);
	assert.equal(p.proposed_limit_aud, 2500.12);
	assert.equal(p.proposed_remaining_allowance_aud, 1650.12);
	s.account.amount_spent = "85010";
	const r = await s.run(apply(p));
	assert.equal(r.verified, true);
	assert.equal(r.verified_limit_aud, 2500.12);
	assert.deepEqual(s.writes(), [
		{ method: "POST", path: "act_123", params: { spend_cap: "250012" } },
	]);
	await s.run(apply(p));
	assert.equal(s.writes().length, 1);
	assert.ok(!JSON.stringify(p).includes("private-test-secret"));
});
test("schema rejects resets, removal, extra fields, invalid precision and missing confirmation", () => {
	for (const a of [
		{ mode: "reset" },
		{ mode: "preview", ...change, new_limit_aud: 0 },
		{ mode: "preview", ...change, new_limit_aud: -1 },
		{ mode: "preview", ...change, new_limit_aud: 1.001 },
		{ mode: "preview", ...change, status: "ACTIVE" },
		{ mode: "apply", ...change, preview_token: "x" },
	])
		assert.equal(schema.safeParse(a).success, false);
});
test("tampered inputs, signature, expiration, identity, currency, cap and reset spend prevent writes", async () => {
	for (const alter of [
		(s) => (s.account.name = "Other"),
		(s) => (s.account.id = "act_999"),
		(s) => (s.account.currency = "USD"),
		(s) => (s.account.timezone_name = "Australia/Adelaide"),
		(s) => (s.account.spend_cap = "110000"),
		(s) => (s.account.account_status = 2),
		(s) => (s.account.disable_reason = 1),
		(s) => (s.account.amount_spent = "1"),
		(s) => s.advance(900001),
	]) {
		const s = setup(),
			p = await preview(s);
		alter(s);
		await assert.rejects(s.run(apply(p)));
		assert.equal(s.writes().length, 0);
	}
	const s = setup(),
		p = await preview(s);
	await assert.rejects(s.run(apply(p, { new_limit_aud: 3000 })));
	await assert.rejects(
		s.run(
			apply(p, {
				preview_token:
					p.preview_token.slice(0, -1) + (p.preview_token.endsWith("0") ? "1" : "0"),
			}),
		),
	);
	assert.equal(s.writes().length, 0);
});
test("missing/invalid financial fields are unknown and block writes; cap below spent is refused", async () => {
	for (const bad of [undefined, null, "", "NaN", "-1", "1.2", "9007199254740993"]) {
		const s = setup();
		s.account.amount_spent = bad;
		assert.equal((await s.run({ mode: "read" })).warning, "UNKNOWN");
		await assert.rejects(preview(s));
		assert.equal(s.writes().length, 0);
	}
	const s = setup();
	await assert.rejects(s.run({ mode: "preview", ...change, new_limit_aud: 800 }));
});
test("missing insights preserve account visibility without pretending a zero spend rate", async () => {
	const s = setup(),
		get = s.deps.get;
	s.deps.get = (path, params) =>
		path.endsWith("/insights")
			? Promise.reject(new Error("secret upstream detail"))
			: get(path, params);
	const r = await s.run({ mode: "read" });
	assert.equal(r.last_7_complete_days.average_daily_spend_aud, null);
	assert.equal(r.warning, "APPROACHING_LIMIT");
});
test("uncertain writes and failed verification are explicit and never retried or rolled back", async () => {
	const s = setup(),
		p = await preview(s);
	let attempts = 0;
	s.deps.post = async () => {
		attempts++;
		throw new Error("secret");
	};
	const r = await s.run(apply(p));
	assert.equal(r.outcome, "UNKNOWN");
	assert.equal(attempts, 1);
	assert.ok(!JSON.stringify(r).includes("secret"));
	const s2 = setup(),
		p2 = await preview(s2);
	s2.deps.post = async () => ({ success: true });
	const r2 = await s2.run(apply(p2));
	assert.equal(r2.outcome, "UNVERIFIED");
});
