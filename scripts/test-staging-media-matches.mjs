import assert from "node:assert/strict";
import test from "node:test";
import { stagingMediaDiagnostics, stagingMediaMatches } from "../src/tools/staging-media-matches.ts";

const origin = "https://staging-online.blindmotion.com.au";
const uploads = "/wp-content/uploads/";
const old = uploads + "2025/10/charcoal.jpg";
const current = uploads + "2026/09/charcoal.jpg";
const other = uploads + "2026/09/moonlight.jpg";
function exactStagePath(value) {
	const u = new URL(value);
	if (u.origin !== origin || !u.pathname.startsWith(uploads) || u.search || u.hash) throw new Error("Invalid staging URL");
	return u.pathname;
}
test("reports all unique paths separately from selections and never matches basename or off-origin", () => {
	const matches = stagingMediaMatches([old, old, current, other], [
		{ id: 1, source_url: origin + current, media_details: { sizes: { full: { source_url: origin + current } } } },
		{ id: 2, source_url: "https://online.blindmotion.com.au" + old },
		{ id: 3, source_url: origin + other + "?variant=1" },
	], exactStagePath);
	assert.deepEqual(stagingMediaDiagnostics(4, matches, false), {
		selection_count: 4, exact_upload_path_count: 3, unique_match_count: 1,
		unmatched_count: 2, ambiguous_count: 0, unmatched_paths: [old, other], ambiguous_paths: [],
		inventory_scope: "staging_attachment_slug_query", inventory_truncated: false,
	});
	assert.equal(matches[1].matches[0].id, 1);
});
test("reports sorted ambiguous IDs and recognises exact registered renditions", () => {
	const matches = stagingMediaMatches([other, current], [
		{ id: 6, source_url: origin + current, media_details: { sizes: { thumbnail: { source_url: origin + other } } } },
		{ id: 4, source_url: origin + other },
	], exactStagePath);
	const result = stagingMediaDiagnostics(2, matches, true);
	assert.equal(result.unmatched_count, 0);
	assert.equal(result.unique_match_count, 1);
	assert.equal(result.inventory_truncated, true);
	assert.deepEqual(result.ambiguous_paths, [{ path: other, attachment_ids: [4, 6] }]);
	assert.equal(matches[1].matches[0].id, 6);
});
