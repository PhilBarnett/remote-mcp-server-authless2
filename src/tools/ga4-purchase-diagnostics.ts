import { z } from "zod";

export const purchaseDiagnosticSchema = z.object({
 start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 report: z.enum(["transactions", "items"]).default("transactions"),
 hostname: z.string().regex(/^[a-zA-Z0-9.-]+$/).optional(),
 limit: z.number().int().min(1).max(1000).default(250),
 offset: z.number().int().min(0).max(100000).default(0),
});
export type PurchaseDiagnosticInput = z.infer<typeof purchaseDiagnosticSchema>;
export function purchaseDiagnosticRequest(input: PurchaseDiagnosticInput) {
 const {start_date, end_date, report, hostname, limit, offset} = input;
 const validDate = (s: string) => {
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
 };
 if (!validDate(start_date) || !validDate(end_date) || start_date > end_date) throw new Error("Expected an ordered range of valid YYYY-MM-DD dates.");
 const filters: any[] = [{filter:{fieldName:"eventName",stringFilter:{matchType:"EXACT",value:"purchase",caseSensitive:true}}}];
 if (hostname) filters.push({filter:{fieldName:"hostName",stringFilter:{matchType:"EXACT",value:hostname,caseSensitive:false}}});
 return {
  dateRanges:[{startDate:start_date,endDate:end_date}],
  dimensions:(report === "items" ? ["date","hostName","transactionId","itemId"] : ["date","hostName","transactionId"]).map(name=>({name})),
  metrics:(report === "items" ? ["itemsPurchased","itemRevenue"] : ["eventCount","ecommercePurchases","purchaseRevenue"]).map(name=>({name})),
  dimensionFilter:{andGroup:{expressions:filters}},
  limit:String(limit),offset:String(offset),
  orderBys:(report === "items" ? ["date","hostName","transactionId","itemId"] : ["date","hostName","transactionId"]).map(dimensionName=>({dimension:{dimensionName}})),
  returnPropertyQuota:true,
 };
}
export function purchaseDiagnosticResult(result: any, input: PurchaseDiagnosticInput, report: any) {
 const rows = result.rows.map((row: any) => {
  const id = String(row.transactionId ?? "");
  const valid = /^#?[1-9]\d*$/.test(id);
  const missing = !id || id === "(not set)";
  return {...row,transactionId:valid ? id : missing ? "(not set)" : "(non-numeric redacted)",
   transaction_id_state:valid ? "numeric_order_candidate" : missing ? "missing" : "non_numeric_redacted"};
 });
 const rowCount = Number(result.row_count);
 const nextOffset = input.offset + rows.length;
 return {...result,rows,report:input.report,offset:input.offset,limit:input.limit,
  has_more:nextOffset < rowCount,next_offset:rows.length && nextOffset < rowCount ? nextOffset : null,
  data_quality:{subject_to_thresholding:report.metadata?.subjectToThresholding ?? false,
   sampling_metadatas:report.metadata?.samplingMetadatas ?? [],data_loss_from_other_row:report.metadata?.dataLossFromOtherRow ?? false,
   empty_reason:report.metadata?.emptyReason ?? null,currency_code:report.metadata?.currencyCode ?? null,time_zone:report.metadata?.timeZone ?? null},
  methodology:"Read-only GA4 purchase-event diagnostics in the GA4 property timezone and currency. Transaction rows and item rows use separate metric scopes: never sum transaction revenue from item rows. Numeric transaction IDs are candidates for WooCommerce order matching, not proof of a match; non-numeric IDs are redacted. Repeated date/host rows or eventCount > 1 are investigation flags, not proof of duplicate orders. GA4 reporting may deduplicate events and cannot prove raw collector exactly-once delivery. Missing GA4 rows may reflect consent, blocking, status/date, refunds or collection differences. Paginate until has_more is false; thresholding/sampling/data loss can limit conclusions. Item revenue excludes tax and shipping. This report does not repair collection or alter feed IDs.",
 };
}
export function registerPurchaseDiagnosticTool(server: any, deps: {
 runReport: (request: any)=>Promise<any>;
 reportResult:(report:any,start:string,end:string)=>any;
 toolResult:(value:any)=>any; toolError:(error:unknown)=>any;
}) {
 server.registerTool("get_ga4_purchase_diagnostics",{
  description:"Read-only GA4 purchase diagnostics by date, hostname and numeric transaction ID, with separately scoped transaction or item rows, pagination and data-quality flags. Used for WooCommerce reconciliation; does not change collection.",
  inputSchema:purchaseDiagnosticSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
 },async (input: PurchaseDiagnosticInput)=>{
  try {const report=await deps.runReport(purchaseDiagnosticRequest(input));
   return deps.toolResult(purchaseDiagnosticResult(deps.reportResult(report,input.start_date,input.end_date),input,report));
  } catch(error) {return deps.toolError(error);}
 });
}
