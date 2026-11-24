export type StagingMediaMatch = { id: number; image: string };

export function stagingMediaMatches(paths: string[], media: unknown[], exactStagingPath: (url: string) => string) {
	const wanted = new Map([...new Set(paths)].map(path => [path, new Map<number, StagingMediaMatch>()]));
	for (const item of media as Array<{ id?: number; source_url?: string; media_details?: { sizes?: Record<string, { source_url?: string }> } }>) {
		const id = item?.id;
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
		const urls = [item.source_url, ...Object.values(item.media_details?.sizes ?? {}).map(size => size?.source_url)];
		for (const url of urls) {
			if (typeof url !== "string") continue;
			let path: string;
			try {
				path = exactStagingPath(url);
			} catch {
				// Off-origin and malformed URLs cannot be evidence of attachment ownership.
				continue;
			}
			wanted.get(path)?.set(id, { id, image: url });
		}
	}
	return [...wanted].map(([path, candidates]) => ({ path, matches: [...candidates.values()] }));
}

export function stagingMediaDiagnostics(selectionCount: number, matches: ReturnType<typeof stagingMediaMatches>, inventoryTruncated: boolean) {
	const unmatched = matches.filter(entry => entry.matches.length === 0).map(entry => entry.path);
	const ambiguous = matches.filter(entry => entry.matches.length > 1).map(entry => ({
		path: entry.path, attachment_ids: entry.matches.map(match => match.id).sort((a, b) => a - b),
	}));
	return {
		selection_count: selectionCount,
		exact_upload_path_count: matches.length,
		unique_match_count: matches.length - unmatched.length - ambiguous.length,
		unmatched_count: unmatched.length,
		ambiguous_count: ambiguous.length,
		unmatched_paths: unmatched,
		ambiguous_paths: ambiguous,
		inventory_scope: "staging_attachment_slug_query",
		inventory_truncated: inventoryTruncated,
	};
}
