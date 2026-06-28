import {
  cleanCell,
  cleanMessage,
  normalizeLotRow,
  toCsv,
  type LotPayload,
} from "@/lib/lots";

export type BulkOperationId =
  | "lots"
  | "location-pick-priority"
  | "location-pickable"
  | "location-sellable"
  | "product-case-barcodes";

export type BulkStatus =
  | "DRY_RUN"
  | "CREATED"
  | "UPDATED"
  | "SKIPPED"
  | "ERROR"
  | "THROTTLED";

export type BulkInputRow = {
  rowNumber: number;
  data: Record<string, string>;
};

export type BulkResult = {
  rowNumber: number | "";
  status: BulkStatus;
  operationId: BulkOperationId;
  identifier?: string;
  sku?: string;
  locationId?: string;
  locationName?: string;
  requestedValue?: string;
  requestId?: string;
  complexity?: string | number;
  message: string;
  nextStep: string;
};

export type BulkRunOptions = {
  dryRun: boolean;
  stopOnError: boolean;
  skipExisting: boolean;
  throttleMs: number;
};

export type LocationUpdatePayload = {
  location_id?: string;
  location_name?: string;
  warehouse_id?: string;
  field: "pick_priority" | "pickable" | "sellable";
  value: number | boolean;
};

export type ProductCaseBarcodePayload = {
  sku: string;
  case_barcode: string;
  case_quantity: number;
  customer_account_id?: string;
};

export type BulkPayload =
  | { operationId: "lots"; payload: LotPayload }
  | {
      operationId:
        | "location-pick-priority"
        | "location-pickable"
        | "location-sellable";
      payload: LocationUpdatePayload;
    }
  | { operationId: "product-case-barcodes"; payload: ProductCaseBarcodePayload };

type BulkOperationConfig = {
  id: BulkOperationId;
  title: string;
  navLabel: string;
  eyebrow: string;
  summary: string;
  templateFileName: string;
  resultsFileName: string;
  requiredColumns: string[];
  optionalColumns: string[];
  sampleRows: string[][];
  dryRunLabel: string;
  liveRunLabel: string;
  successLabel: string;
  supportsSkipExisting: boolean;
};

export const BULK_OPERATIONS: BulkOperationConfig[] = [
  {
    id: "lots",
    title: "Lots and Expirations",
    navLabel: "Lots",
    eyebrow: "Inventory",
    summary: "Create lot records with optional expiration dates.",
    templateFileName: "shiphero-lots-template.csv",
    resultsFileName: "shiphero-lots-results.csv",
    requiredColumns: ["sku", "name"],
    optionalColumns: ["expires_at", "is_active", "customer_account_id", "notes"],
    sampleRows: [
      [
        "SKU-12345",
        "LOT-2026-001",
        "2026-12-31",
        "true",
        "",
        "customer_account_id is usually blank when using a child-account refresh token",
      ],
    ],
    dryRunLabel: "Check lot CSV",
    liveRunLabel: "Create lots",
    successLabel: "Created",
    supportsSkipExisting: true,
  },
  {
    id: "location-pick-priority",
    title: "Location Pick Priority",
    navLabel: "Pick Priority",
    eyebrow: "Locations",
    summary: "Update location pick priority by location ID or location name.",
    templateFileName: "shiphero-location-pick-priority-template.csv",
    resultsFileName: "shiphero-location-pick-priority-results.csv",
    requiredColumns: ["location_id or location_name", "pick_priority"],
    optionalColumns: ["warehouse_id", "notes"],
    sampleRows: [["", "A-01-01", "V2FyZWhvdXNlOjEyMzQ=", "10", "Use location_id when available"]],
    dryRunLabel: "Check priority CSV",
    liveRunLabel: "Update priority",
    successLabel: "Updated",
    supportsSkipExisting: false,
  },
  {
    id: "location-pickable",
    title: "Location Pickable",
    navLabel: "Pickable",
    eyebrow: "Locations",
    summary: "Set locations as pickable or non-pickable.",
    templateFileName: "shiphero-location-pickable-template.csv",
    resultsFileName: "shiphero-location-pickable-results.csv",
    requiredColumns: ["location_id or location_name", "pickable"],
    optionalColumns: ["warehouse_id", "notes"],
    sampleRows: [["", "A-01-01", "V2FyZWhvdXNlOjEyMzQ=", "true", "true/false, yes/no, or 1/0"]],
    dryRunLabel: "Check pickable CSV",
    liveRunLabel: "Update pickable",
    successLabel: "Updated",
    supportsSkipExisting: false,
  },
  {
    id: "location-sellable",
    title: "Location Sellable",
    navLabel: "Sellable",
    eyebrow: "Locations",
    summary: "Set locations as sellable or non-sellable.",
    templateFileName: "shiphero-location-sellable-template.csv",
    resultsFileName: "shiphero-location-sellable-results.csv",
    requiredColumns: ["location_id or location_name", "sellable"],
    optionalColumns: ["warehouse_id", "notes"],
    sampleRows: [["", "A-01-01", "V2FyZWhvdXNlOjEyMzQ=", "false", "true/false, yes/no, or 1/0"]],
    dryRunLabel: "Check sellable CSV",
    liveRunLabel: "Update sellable",
    successLabel: "Updated",
    supportsSkipExisting: false,
  },
  {
    id: "product-case-barcodes",
    title: "Product Case Barcodes",
    navLabel: "Case Barcodes",
    eyebrow: "Products",
    summary: "Add or update product case barcodes by SKU.",
    templateFileName: "shiphero-product-case-barcodes-template.csv",
    resultsFileName: "shiphero-product-case-barcodes-results.csv",
    requiredColumns: ["sku", "case_barcode", "case_quantity"],
    optionalColumns: ["customer_account_id", "notes"],
    sampleRows: [["SKU-12345", "CASE-SKU-12345-12", "12", "", ""]],
    dryRunLabel: "Check case CSV",
    liveRunLabel: "Update cases",
    successLabel: "Updated",
    supportsSkipExisting: true,
  },
];

export const RESULT_HEADERS = [
  "source_row",
  "status",
  "tool",
  "identifier",
  "sku",
  "location_id",
  "location_name",
  "requested_value",
  "request_id",
  "complexity",
  "message",
  "next_step",
] as const;

const HEADERS: Record<BulkOperationId, string[]> = {
  lots: ["sku", "name", "expires_at", "is_active", "customer_account_id", "notes"],
  "location-pick-priority": [
    "location_id",
    "location_name",
    "warehouse_id",
    "pick_priority",
    "notes",
  ],
  "location-pickable": ["location_id", "location_name", "warehouse_id", "pickable", "notes"],
  "location-sellable": ["location_id", "location_name", "warehouse_id", "sellable", "notes"],
  "product-case-barcodes": [
    "sku",
    "case_barcode",
    "case_quantity",
    "customer_account_id",
    "notes",
  ],
};

const HEADER_ALIASES: Record<string, string[]> = {
  sku: ["sku", "product_sku", "item_sku"],
  name: ["name", "lot", "lot_name", "lot_number", "lot_id"],
  expires_at: [
    "expires_at",
    "expiration",
    "expiration_date",
    "expiration_datetime",
    "expiry",
    "expiry_date",
    "expires",
  ],
  is_active: ["is_active", "active", "enabled"],
  customer_account_id: [
    "customer_account_id",
    "customer_id",
    "client_account_id",
    "child_account_id",
  ],
  location_id: ["location_id", "bin_id", "bin_location_id", "id"],
  location_name: ["location_name", "location", "bin", "bin_name", "bin_location", "name"],
  warehouse_id: ["warehouse_id", "warehouse", "warehouse_uuid"],
  pick_priority: ["pick_priority", "priority", "pick_sequence", "sequence"],
  pickable: ["pickable", "is_pickable"],
  sellable: ["sellable", "is_sellable"],
  case_barcode: ["case_barcode", "case_barcode_value", "case_upc", "case_gtin", "barcode"],
  case_quantity: ["case_quantity", "case_qty", "quantity", "qty", "units_per_case"],
  notes: ["notes", "note", "memo"],
};

export function getOperationConfig(operationId: BulkOperationId): BulkOperationConfig {
  return BULK_OPERATIONS.find((operation) => operation.id === operationId) ?? BULK_OPERATIONS[0];
}

export function parseBulkCsv(text: string, operationId: BulkOperationId): BulkInputRow[] {
  const matrix = parseDelimited(text);
  if (!matrix.length) {
    throw new Error("CSV is empty.");
  }

  const rawHeaders = matrix[0].map((header) => header.trim());
  assertRequiredHeaders(operationId, rawHeaders);

  return matrix
    .slice(1)
    .map((cells, index) => {
      const data: Record<string, string> = {};
      rawHeaders.forEach((header, columnIndex) => {
        data[header] = cleanCell(cells[columnIndex]);
      });

      return {
        rowNumber: index + 2,
        data,
      };
    })
    .filter((row) => Object.values(row.data).some((value) => cleanCell(value)));
}

export function normalizeBulkRow(operationId: BulkOperationId, row: BulkInputRow): BulkPayload {
  if (operationId === "lots") {
    return { operationId, payload: normalizeLotRow(row) };
  }

  if (
    operationId === "location-pick-priority" ||
    operationId === "location-pickable" ||
    operationId === "location-sellable"
  ) {
    return { operationId, payload: normalizeLocationUpdateRow(operationId, row) };
  }

  return { operationId, payload: normalizeProductCaseBarcodeRow(row) };
}

export function normalizeRunOptions(options: Partial<BulkRunOptions> = {}): BulkRunOptions {
  const throttleMs = Math.max(0, Math.min(Number(options.throttleMs ?? 150), 2000));

  return {
    dryRun: Boolean(options.dryRun),
    stopOnError: Boolean(options.stopOnError),
    skipExisting: options.skipExisting !== false,
    throttleMs,
  };
}

export function templateCsvForOperation(operationId: BulkOperationId): string {
  const config = getOperationConfig(operationId);
  return toCsv([HEADERS[operationId], ...config.sampleRows]);
}

export function resultsToCsv(results: BulkResult[]): string {
  const rows = results.map((result) => [
    result.rowNumber,
    result.status,
    getOperationConfig(result.operationId).title,
    result.identifier ?? "",
    result.sku ?? "",
    result.locationId ?? "",
    result.locationName ?? "",
    result.requestedValue ?? "",
    result.requestId ?? "",
    result.complexity ?? "",
    result.message,
    result.nextStep,
  ]);

  return toCsv([[...RESULT_HEADERS], ...rows]);
}

export function countResults(results: BulkResult[]) {
  return results.reduce(
    (acc, result) => {
      acc.total += 1;
      if (result.status === "CREATED") acc.created += 1;
      if (result.status === "UPDATED") acc.updated += 1;
      if (result.status === "DRY_RUN") acc.validated += 1;
      if (result.status === "SKIPPED") acc.skipped += 1;
      if (result.status === "ERROR") acc.errors += 1;
      if (result.status === "THROTTLED") acc.throttled += 1;
      return acc;
    },
    { total: 0, created: 0, updated: 0, validated: 0, skipped: 0, errors: 0, throttled: 0 },
  );
}

export function bulkPayloadIdentifier(payload: BulkPayload): string {
  if (payload.operationId === "lots") {
    return `${payload.payload.sku} / ${payload.payload.name}`;
  }
  if (payload.operationId === "product-case-barcodes") {
    return `${payload.payload.sku} / ${payload.payload.case_barcode}`;
  }
  return payload.payload.location_id || payload.payload.location_name || "location";
}

export function requestedValue(payload: BulkPayload): string {
  if (payload.operationId === "lots") {
    return payload.payload.expires_at ?? "";
  }
  if (payload.operationId === "product-case-barcodes") {
    return `${payload.payload.case_barcode} x ${payload.payload.case_quantity}`;
  }
  return `${payload.payload.field} = ${String(payload.payload.value)}`;
}

export function baseResult(
  operationId: BulkOperationId,
  row: BulkInputRow,
  payload?: BulkPayload,
): Pick<
  BulkResult,
  "rowNumber" | "operationId" | "identifier" | "sku" | "locationId" | "locationName" | "requestedValue"
> {
  const result = {
    rowNumber: row.rowNumber,
    operationId,
    identifier: payload ? bulkPayloadIdentifier(payload) : "",
    requestedValue: payload ? requestedValue(payload) : "",
  };

  if (payload?.operationId === "lots") {
    return {
      ...result,
      sku: payload.payload.sku,
    };
  }
  if (payload?.operationId === "product-case-barcodes") {
    return {
      ...result,
      sku: payload.payload.sku,
    };
  }
  if (payload) {
    return {
      ...result,
      locationId: payload.payload.location_id ?? "",
      locationName: payload.payload.location_name ?? "",
    };
  }

  return result;
}

export function successNextStep(status: BulkStatus): string {
  if (status === "DRY_RUN") {
    return "Run live mode after verifying the connected account.";
  }
  if (status === "SKIPPED") {
    return "No change needed for this row.";
  }
  return "No action needed.";
}

export function suggestFix(error: unknown, operationId: BulkOperationId): string {
  const message = cleanMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("missing required") || lower.includes("must include")) {
    return `Fix the CSV headers or row values for ${getOperationConfig(operationId).requiredColumns.join(", ")}.`;
  }
  if (lower.includes("invalid") && lower.includes("boolean")) {
    return "Use true/false, yes/no, y/n, or 1/0.";
  }
  if (lower.includes("pick_priority")) {
    return "Use a whole number for pick_priority.";
  }
  if (lower.includes("case_quantity")) {
    return "Use a whole number greater than zero for case_quantity.";
  }
  if (lower.includes("not found") || lower.includes("did not return")) {
    if (operationId.startsWith("location")) {
      return "Check the location_id. If using location_name, include warehouse_id or switch to location_id.";
    }
    return "Check the SKU and customer_account_id, then rerun only the failed rows.";
  }
  if (lower.includes("multiple") || lower.includes("ambiguous")) {
    return "Use the exact ShipHero ID instead of a name so the row points to one record.";
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("access token")) {
    return "Reconnect with a valid refresh token and the matching OAuth client ID.";
  }
  if (lower.includes("403") || lower.includes("permission")) {
    return "Confirm the token belongs to the right account and has permission for this object.";
  }
  if (lower.includes("thrott") || lower.includes("rate limit") || lower.includes("wait")) {
    return "Wait the time shown by ShipHero, then rerun the failed rows with a higher delay.";
  }
  if (lower.includes("timed out")) {
    return "Rerun the failed rows. If it repeats, increase the delay between requests.";
  }

  return "Review the message, fix the CSV row or account access, then rerun only failed rows.";
}

function assertRequiredHeaders(operationId: BulkOperationId, rawHeaders: string[]) {
  const canonicalHeaders = rawHeaders.map(canonicalHeader).filter(Boolean);

  if (operationId === "lots") {
    requireHeaders(operationId, canonicalHeaders, ["sku", "name"]);
    return;
  }
  if (operationId === "product-case-barcodes") {
    requireHeaders(operationId, canonicalHeaders, ["sku", "case_barcode", "case_quantity"]);
    return;
  }

  const config = getOperationConfig(operationId);
  const hasLocation = canonicalHeaders.includes("location_id") || canonicalHeaders.includes("location_name");
  const valueHeader =
    operationId === "location-pick-priority"
      ? "pick_priority"
      : operationId === "location-pickable"
        ? "pickable"
        : "sellable";

  if (!hasLocation || !canonicalHeaders.includes(valueHeader)) {
    throw new Error(`CSV must include ${config.requiredColumns.join(", ")}.`);
  }
}

function requireHeaders(
  operationId: BulkOperationId,
  canonicalHeaders: string[],
  requiredHeaders: string[],
) {
  const missing = requiredHeaders.filter((header) => !canonicalHeaders.includes(header));
  if (missing.length) {
    throw new Error(
      `CSV must include ${getOperationConfig(operationId).requiredColumns.join(", ")}.`,
    );
  }
}

function normalizeLocationUpdateRow(
  operationId:
    | "location-pick-priority"
    | "location-pickable"
    | "location-sellable",
  row: BulkInputRow,
): LocationUpdatePayload {
  const mapped = mappedRow(row);
  const locationId = cleanCell(mapped.location_id);
  const locationName = cleanCell(mapped.location_name);
  const warehouseId = cleanCell(mapped.warehouse_id);

  if (!locationId && !locationName) {
    throw new Error("Missing required location_id or location_name.");
  }

  if (operationId === "location-pick-priority") {
    return {
      location_id: locationId || undefined,
      location_name: locationName || undefined,
      warehouse_id: warehouseId || undefined,
      field: "pick_priority",
      value: parseInteger(cleanCell(mapped.pick_priority), "pick_priority", { min: 0 }),
    };
  }

  if (operationId === "location-pickable") {
    return {
      location_id: locationId || undefined,
      location_name: locationName || undefined,
      warehouse_id: warehouseId || undefined,
      field: "pickable",
      value: parseBoolean(cleanCell(mapped.pickable), "pickable"),
    };
  }

  return {
    location_id: locationId || undefined,
    location_name: locationName || undefined,
    warehouse_id: warehouseId || undefined,
    field: "sellable",
    value: parseBoolean(cleanCell(mapped.sellable), "sellable"),
  };
}

function normalizeProductCaseBarcodeRow(row: BulkInputRow): ProductCaseBarcodePayload {
  const mapped = mappedRow(row);
  const sku = cleanCell(mapped.sku);
  const caseBarcode = cleanCell(mapped.case_barcode);
  const caseQuantity = parseInteger(cleanCell(mapped.case_quantity), "case_quantity", { min: 1 });
  const customerAccountId = cleanCell(mapped.customer_account_id);

  if (!sku) {
    throw new Error("Missing required sku.");
  }
  if (!caseBarcode) {
    throw new Error("Missing required case_barcode.");
  }

  return {
    sku,
    case_barcode: caseBarcode,
    case_quantity: caseQuantity,
    customer_account_id: customerAccountId || undefined,
  };
}

function mappedRow(row: BulkInputRow): Record<string, string> {
  const mapped: Record<string, string> = {};
  Object.entries(row.data ?? {}).forEach(([header, value]) => {
    const canonical = canonicalHeader(header);
    if (canonical) {
      mapped[canonical] = value;
    }
  });
  return mapped;
}

function canonicalHeader(header: string): string {
  const normalized = String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return (
    Object.entries(HEADER_ALIASES).find(([, aliases]) => aliases.includes(normalized))?.[0] ??
    ""
  );
}

function parseBoolean(value: string, label: string): boolean {
  const text = cleanCell(value).toLowerCase();
  if (["true", "yes", "y", "1", "active", "enabled", "pickable", "sellable"].includes(text)) {
    return true;
  }
  if (
    ["false", "no", "n", "0", "inactive", "disabled", "non_pickable", "non_sellable"].includes(
      text,
    )
  ) {
    return false;
  }
  throw new Error(`Invalid ${label} value: ${value}. Expected true/false.`);
}

function parseInteger(value: string, label: string, options: { min?: number } = {}): number {
  const text = cleanCell(value);
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`Invalid ${label} value: ${value}. Expected a whole number.`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${label} value: ${value}. Expected a safe whole number.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Invalid ${label} value: ${value}. Must be at least ${options.min}.`);
  }
  return parsed;
}

function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((cells) => cells.some((value) => cleanCell(value)));
}
