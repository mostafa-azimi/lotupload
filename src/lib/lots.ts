export const TEMPLATE_HEADERS = [
  "sku",
  "name",
  "expires_at",
  "is_active",
  "customer_account_id",
  "notes",
] as const;

export const RESULT_HEADERS = [
  "source_row",
  "status",
  "lot_name",
  "sku",
  "expires_at",
  "lot_id",
  "request_id",
  "complexity",
  "message",
] as const;

export type CanonicalLotField = (typeof TEMPLATE_HEADERS)[number];

export type LotPayload = {
  name: string;
  sku: string;
  expires_at?: string;
  is_active?: boolean;
  customer_account_id?: string;
};

export type LotInputRow = {
  rowNumber: number;
  data: Record<string, string>;
};

export type LotResult = {
  rowNumber: number | "";
  status: "DRY_RUN" | "CREATED" | "SKIPPED" | "ERROR" | "THROTTLED";
  lotName?: string;
  sku?: string;
  expiresAt?: string;
  lotId?: string;
  requestId?: string;
  complexity?: string | number;
  message: string;
};

export type RunOptions = {
  dryRun: boolean;
  stopOnError: boolean;
  skipExisting: boolean;
  throttleMs: number;
};

const HEADER_ALIASES: Record<CanonicalLotField, string[]> = {
  name: ["name", "lot", "lot_name", "lot_number", "lot_id"],
  sku: ["sku", "product_sku", "item_sku"],
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
  notes: ["notes", "note", "memo"],
};

export const SAMPLE_CSV = toCsv([
  [...TEMPLATE_HEADERS],
  [
    "SKU-12345",
    "LOT-2026-001",
    "2026-12-31",
    "true",
    "",
    "Leave blank when using a saved 3PL child profile",
  ],
]);

export function normalizeLotRow(row: LotInputRow): LotPayload {
  const raw = row?.data ?? {};
  const mapped: Partial<Record<CanonicalLotField, string>> = {};

  Object.entries(raw).forEach(([header, value]) => {
    const canonical = canonicalHeader(header);
    if (canonical) {
      mapped[canonical] = value;
    }
  });

  const name = cleanCell(mapped.name);
  const sku = cleanCell(mapped.sku);
  if (!name) {
    throw new Error("Missing required name.");
  }
  if (!sku) {
    throw new Error("Missing required sku.");
  }

  const payload: LotPayload = { name, sku };
  const expiresAt = cleanCell(mapped.expires_at);
  if (expiresAt) {
    payload.expires_at = normalizeDateTime(expiresAt);
  }

  const isActive = cleanCell(mapped.is_active);
  if (isActive) {
    payload.is_active = parseBoolean(isActive);
  }

  const customerAccountId = cleanCell(mapped.customer_account_id);
  if (customerAccountId) {
    payload.customer_account_id = customerAccountId;
  }

  return payload;
}

export function normalizeRunOptions(
  options: Partial<RunOptions> = {},
): RunOptions {
  const throttleMs = Math.max(
    0,
    Math.min(Number(options.throttleMs ?? 150), 2000),
  );

  return {
    dryRun: Boolean(options.dryRun),
    stopOnError: Boolean(options.stopOnError),
    skipExisting: options.skipExisting !== false,
    throttleMs,
  };
}

export function canonicalHeader(header: string): CanonicalLotField | "" {
  const normalized = String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return (
    (Object.entries(HEADER_ALIASES).find(([, aliases]) =>
      aliases.includes(normalized),
    )?.[0] as CanonicalLotField | undefined) ?? ""
  );
}

export function parseCsv(text: string): LotInputRow[] {
  const matrix = parseDelimited(text);
  if (!matrix.length) {
    throw new Error("CSV is empty.");
  }

  const rawHeaders = matrix[0].map((header) => header.trim());
  const hasName = rawHeaders.some(
    (header) => canonicalHeader(header) === "name",
  );
  const hasSku = rawHeaders.some((header) => canonicalHeader(header) === "sku");
  if (!hasName || !hasSku) {
    throw new Error("CSV must include name and sku columns.");
  }

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

export function toResultsCsv(results: LotResult[]): string {
  const rows = results.map((result) => [
    result.rowNumber,
    result.status,
    result.lotName ?? "",
    result.sku ?? "",
    result.expiresAt ?? "",
    result.lotId ?? "",
    result.requestId ?? "",
    result.complexity ?? "",
    result.message,
  ]);

  return toCsv([[...RESULT_HEADERS], ...rows]);
}

export function toCsv(
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          if (/[",\n\r]/.test(value)) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(","),
    )
    .join("\n");
}

export function cleanMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Request failed.";

  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [hidden]")
    .replace(/refresh_token[=:]\s*[^&\s]+/gi, "refresh_token=[hidden]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[hidden]");
}

export function cleanCell(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeDateTime(value: string): string {
  const text = cleanCell(value);
  let candidate = text;
  let match = candidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (match) {
    candidate = `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
  } else {
    match = candidate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
      candidate = `${match[3]}-${leftPad(match[1], 2)}-${leftPad(
        match[2],
        2,
      )}T00:00:00Z`;
    } else {
      candidate = candidate.replace(" ", "T");
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(candidate)) {
        candidate += ":00Z";
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(candidate)) {
        candidate += "Z";
      }
    }
  }

  if (Number.isNaN(Date.parse(candidate))) {
    throw new Error(`Invalid expires_at value: ${text}`);
  }

  return candidate;
}

function parseBoolean(value: string): boolean {
  const text = cleanCell(value).toLowerCase();
  if (["true", "yes", "y", "1", "active", "enabled"].includes(text)) {
    return true;
  }
  if (["false", "no", "n", "0", "inactive", "disabled"].includes(text)) {
    return false;
  }
  throw new Error(`Invalid is_active value: ${value}`);
}

function leftPad(value: string, targetLength: number): string {
  return value.padStart(targetLength, "0");
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
