import fs from "node:fs";

const file = "src/index.ts";
let source = fs.readFileSync(file, "utf8");

source = source.replace(
`function cohortDateMs(value: unknown) {
\tconst date = String(value ?? "").slice(0, 10);
\tconst ms = Date.parse(date + "T00:00:00Z");
\treturn Number.isFinite(ms) ? ms : null;
}`,
`function cohortDateMs(value: unknown) {
\tconst date = String(value ?? "").slice(0, 10);
\tconst ms = Date.parse(date + "T00:00:00Z");
\treturn Number.isFinite(ms) ? ms : null;
}

function cohortTimestampMs(value: unknown) {
\tconst ms = Date.parse(String(value ?? ""));
\treturn Number.isFinite(ms) ? ms : null;
}`,
);

source = source.replace(
`\t\t\t\t\t\tconst sampleMs = cohortDateMs(customer.first_sample_date)!;
\t\t\t\t\t\tconst windowEndMs = sampleMs + windowDays * 86_400_000;`,
`\t\t\t\t\t\tconst sampleMs = cohortDateMs(customer.first_sample_date)!;
\t\t\t\t\t\tconst sampleTimestampMs = cohortTimestampMs(
\t\t\t\t\t\t\tsampleOrders.find((order) => Number(order.id) === customer.first_sample_order_id)?.date_created,
\t\t\t\t\t\t) ?? sampleMs;
\t\t\t\t\t\tconst windowEndMs = sampleMs + windowDays * 86_400_000;`,
);

source = source.replace(
`\t\t\t\t\t\t\t\tconst purchaseMs = cohortDateMs(order?.date_created);
\t\t\t\t\t\t\t\treturn purchaseMs !== null && purchaseMs > sampleMs && purchaseMs <= windowEndMs;`,
`\t\t\t\t\t\t\t\tconst purchaseMs = cohortDateMs(order?.date_created);
\t\t\t\t\t\t\t\tconst purchaseTimestampMs = cohortTimestampMs(order?.date_created);
\t\t\t\t\t\t\t\treturn (
\t\t\t\t\t\t\t\t\tpurchaseMs !== null &&
\t\t\t\t\t\t\t\t\tpurchaseTimestampMs !== null &&
\t\t\t\t\t\t\t\t\tpurchaseTimestampMs > sampleTimestampMs &&
\t\t\t\t\t\t\t\t\tpurchaseMs <= windowEndMs
\t\t\t\t\t\t\t\t);`,
);

source = source.replace(
`\t\t\t\t\t\texpected_gross_profit_per_matured_sample_customer_aud:
\t\t\t\t\t\t\texpectedOrderRevenue === null
\t\t\t\t\t\t\t\t? null
\t\t\t\t\t\t\t\t: expectedOrderRevenue * (gross_margin_pct / 100),`,
`\t\t\t\t\t\texpected_gross_profit_per_matured_sample_customer_aud:
\t\t\t\t\t\t\texpectedZipGripRevenue === null
\t\t\t\t\t\t\t\t? null
\t\t\t\t\t\t\t\t: expectedZipGripRevenue * (gross_margin_pct / 100),`,
);

fs.writeFileSync(file, source);
console.log("Refined cohort timing and ZipGrip-only gross-profit logic.");
