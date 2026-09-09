import fs from 'node:fs';

const path = 'src/index.ts';
let text = fs.readFileSync(path, 'utf8');

const start = text.indexOf('async function googleAdsSearch(query: string) {');
const end = text.indexOf('\nasync function googleAdsMutate(', start);
if (start < 0 || end < 0) throw new Error('googleAdsSearch helper markers not found');

const helper = `async function googleAdsSearchCustomer(customerId: string, query: string) {
\tif (!/^\\d{10}$/.test(customerId)) {
\t\tthrow new Error("Google Ads target customer ID must contain exactly 10 digits.");
\t}

\tconst { developerToken, loginCustomerId } = getGoogleAdsConfig();
\tconst accessToken = await getGoogleAdsAccessToken();
\tconst results: any[] = [];
\tlet pageToken: string | undefined;

\tdo {
\t\tconst response = await fetch(
\t\t\t\`https://googleads.googleapis.com/v25/customers/\${customerId}/googleAds:search\`,
\t\t\t{
\t\t\t\tmethod: "POST",
\t\t\t\theaders: {
\t\t\t\t\tAuthorization: \`Bearer \${accessToken}\`,
\t\t\t\t\t"developer-token": developerToken,
\t\t\t\t\t"login-customer-id": loginCustomerId,
\t\t\t\t\t"Content-Type": "application/json",
\t\t\t\t\tAccept: "application/json",
\t\t\t\t},
\t\t\t\tbody: JSON.stringify({ query, pageToken }),
\t\t\t},
\t\t);

\t\tif (!response.ok) {
\t\t\tthrow new Error(
\t\t\t\t\`Google Ads API request for customer \${customerId} failed: \${response.status} \${await response.text()}\`,
\t\t\t);
\t\t}

\t\tconst page = await response.json<{ results?: any[]; nextPageToken?: string }>();
\t\tresults.push(...(page.results ?? []));
\t\tpageToken = page.nextPageToken;
\t} while (pageToken && results.length < 10_000);

\treturn results;
}

async function googleAdsSearch(query: string) {
\tconst { customerId } = getGoogleAdsConfig();
\treturn googleAdsSearchCustomer(customerId, query);
}
`;
text = text.slice(0, start) + helper + text.slice(end);

const marker = '\tserver.registerTool(\n\t\t"get_google_ads_summary",';
const insertAt = text.indexOf(marker);
if (insertAt < 0) throw new Error('Google Ads summary tool marker not found');

const tool = `\tserver.registerTool(
\t\t"find_google_ads_campaign_across_manager",
\t\t{
\t\t\tdescription:
\t\t\t\t"Locate one or more Google Ads campaign IDs across all accessible non-manager client accounts beneath the configured manager account. Read-only diagnostic for attribution reconciliation.",
\t\t\tinputSchema: z.object({
\t\t\t\tcampaign_ids: z.array(z.string().regex(/^\\d+$/)).min(1).max(20),
\t\t\t}),
\t\t},
\t\tasync ({ campaign_ids }) => {
\t\t\ttry {
\t\t\t\tconst { loginCustomerId, customerId } = getGoogleAdsConfig();
\t\t\t\tconst uniqueCampaignIds = [...new Set(campaign_ids.map((id) => id.trim()))];
\t\t\t\tconst idsClause = uniqueCampaignIds.join(", ");

\t\t\t\tconst clientRows = await googleAdsSearchCustomer(
\t\t\t\t\tloginCustomerId,
\t\t\t\t\t\`SELECT customer_client.id, customer_client.descriptive_name,
\t\t\t\t\t\tcustomer_client.manager, customer_client.level, customer_client.status
\t\t\t\t\tFROM customer_client
\t\t\t\t\tWHERE customer_client.level > 0\`,
\t\t\t\t);

\t\t\t\tconst clients = new Map<string, { customer_id: string; customer_name: string | null; level: number | null }>();
\t\t\t\tfor (const row of clientRows) {
\t\t\t\t\tconst client = row.customerClient;
\t\t\t\t\tconst id = String(client?.id ?? "");
\t\t\t\t\tif (!/^\\d{10}$/.test(id) || client?.manager === true) continue;
\t\t\t\t\tclients.set(id, {
\t\t\t\t\t\tcustomer_id: id,
\t\t\t\t\t\tcustomer_name: client?.descriptiveName ?? null,
\t\t\t\t\t\tlevel: Number.isFinite(Number(client?.level)) ? Number(client.level) : null,
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\tif (!clients.has(customerId)) {
\t\t\t\t\tclients.set(customerId, { customer_id: customerId, customer_name: null, level: null });
\t\t\t\t}

\t\t\t\tconst matches: any[] = [];
\t\t\t\tconst unqueryableClients: any[] = [];
\t\t\t\tfor (const client of clients.values()) {
\t\t\t\t\ttry {
\t\t\t\t\t\tconst rows = await googleAdsSearchCustomer(
\t\t\t\t\t\t\tclient.customer_id,
\t\t\t\t\t\t\t\`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
\t\t\t\t\t\t\tFROM campaign
\t\t\t\t\t\t\tWHERE campaign.id IN (\${idsClause})\`,
\t\t\t\t\t\t);
\t\t\t\t\t\tfor (const row of rows) {
\t\t\t\t\t\t\tmatches.push({
\t\t\t\t\t\t\t\tcustomer_id: client.customer_id,
\t\t\t\t\t\t\t\tcustomer_name: client.customer_name,
\t\t\t\t\t\t\t\tmanager_level: client.level,
\t\t\t\t\t\t\t\tcampaign: row.campaign,
\t\t\t\t\t\t\t});
\t\t\t\t\t\t}
\t\t\t\t\t} catch (error) {
\t\t\t\t\t\tunqueryableClients.push({
\t\t\t\t\t\t\tcustomer_id: client.customer_id,
\t\t\t\t\t\t\tcustomer_name: client.customer_name,
\t\t\t\t\t\t\tmanager_level: client.level,
\t\t\t\t\t\t\terror: error instanceof Error ? error.message : String(error),
\t\t\t\t\t\t});
\t\t\t\t\t}
\t\t\t\t}

\t\t\t\tconst matchedIds = new Set(matches.map((match) => String(match.campaign?.id ?? "")));
\t\t\t\treturn toolResult({
\t\t\t\t\tmanager_customer_id: loginCustomerId,
\t\t\t\t\tconfigured_customer_id: customerId,
\t\t\t\t\trequested_campaign_ids: uniqueCampaignIds,
\t\t\t\t\tclient_accounts_considered: clients.size,
\t\t\t\t\tmatches,
\t\t\t\t\tunmatched_campaign_ids: uniqueCampaignIds.filter((id) => !matchedIds.has(id)),
\t\t\t\t\tunqueryable_clients: unqueryableClients,
\t\t\t\t\tread_only: true,
\t\t\t\t});
\t\t\t} catch (error) {
\t\t\t\treturn toolError(error);
\t\t\t}
\t\t},
\t);

`;

text = text.slice(0, insertAt) + tool + text.slice(insertAt);
fs.writeFileSync(path, text);
