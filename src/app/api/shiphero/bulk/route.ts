import { NextResponse } from "next/server";
import {
  baseResult,
  getOperationConfig,
  normalizeBulkRow,
  normalizeRunOptions,
  successNextStep,
  suggestFix,
  type BulkInputRow,
  type BulkOperationId,
  type BulkPayload,
  type BulkResult,
  type BulkRunOptions,
  type BulkStatus,
  type LocationUpdatePayload,
} from "@/lib/bulk";
import { cleanMessage } from "@/lib/lots";
import {
  createTraceId,
  fingerprintSecret,
  logEvent,
  readTraceId,
} from "@/lib/logging";
import {
  createLot,
  findExistingLot,
  refreshAccessToken,
  resolveLocation,
  updateLocation,
  updateProductCaseBarcode,
  type ProductCaseCache,
  type ShipHeroLocation,
} from "@/lib/shiphero";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const traceId = createTraceId("bulk");

  try {
    const body = (await request.json()) as {
      operationId?: BulkOperationId;
      refreshToken?: string;
      clientId?: string;
      selectedCustomerAccountId?: string;
      rows?: BulkInputRow[];
      options?: Partial<BulkRunOptions>;
    };
    const operationId = normalizeOperationId(body.operationId);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const options = normalizeRunOptions(body.options);
    const selectedCustomerAccountId = normalizeOptionalString(
      body.selectedCustomerAccountId,
    );

    logEvent("info", "shiphero.bulk.request.received", {
      traceId,
      operationId,
      operationTitle: getOperationConfig(operationId).title,
      rowCount: rows.length,
      dryRun: options.dryRun,
      stopOnError: options.stopOnError,
      skipExisting: options.skipExisting,
      throttleMs: options.throttleMs,
      hasClientId: Boolean(body.clientId?.trim()),
      hasRefreshToken: Boolean(body.refreshToken?.trim()),
      hasSelectedCustomerAccountId: Boolean(selectedCustomerAccountId),
      clientIdFingerprint: fingerprintSecret(body.clientId),
      refreshTokenFingerprint: fingerprintSecret(body.refreshToken),
    });

    if (!rows.length) {
      throw new Error("No CSV rows were provided.");
    }

    const refreshed = options.dryRun
      ? null
      : await refreshAccessToken(body.refreshToken ?? "", body.clientId, {
          traceId,
          operation: `${operationId}:refresh`,
        });
    const accessToken = refreshed?.accessToken ?? "";
    const results: BulkResult[] = [];
    const productCaseCache: ProductCaseCache = new Map();
    let halted = false;

    for (const row of rows) {
      let normalized: BulkPayload | undefined;

      try {
        normalized = applySelectedCustomerAccount(
          normalizeBulkRow(operationId, row),
          selectedCustomerAccountId,
        );

        logEvent("info", "shiphero.bulk.row.start", {
          traceId,
          operationId,
          rowNumber: row.rowNumber,
          identifier: normalized ? normalizedIdentifier(normalized) : "",
          dryRun: options.dryRun,
        });

        if (options.dryRun) {
          const result: BulkResult = {
            ...baseResult(operationId, row, normalized),
            status: "DRY_RUN",
            message: "Validated only.",
            nextStep: successNextStep("DRY_RUN"),
          };
          results.push(result);
          logRowCompleted(traceId, result);
        } else {
          const result = await runLiveRow(
            accessToken,
            operationId,
            row,
            normalized,
            options,
            traceId,
            productCaseCache,
          );
          results.push(result);
          logRowCompleted(traceId, result);
        }
      } catch (error) {
        const status = isThrottleError(error) ? "THROTTLED" : "ERROR";
        const errorTraceId = readTraceId(error) || traceId;

        logEvent(
          status === "THROTTLED" ? "warn" : "error",
          "shiphero.bulk.row.failed",
          {
            traceId: errorTraceId,
            operationId,
            rowNumber: row?.rowNumber ?? "",
            status,
            shipheroRequestId: readRequestId(error),
            error: cleanMessage(error),
          },
        );

        results.push({
          ...baseResult(operationId, row, normalized),
          status,
          requestId: readRequestId(error),
          message: cleanMessage(error),
          nextStep: suggestFix(error, operationId),
        });

        if (options.stopOnError || status === "THROTTLED") {
          halted = true;
          break;
        }
      }

      if (!options.dryRun && options.throttleMs > 0) {
        await sleep(options.throttleMs);
      }
    }

    logEvent(halted ? "warn" : "info", "shiphero.bulk.request.completed", {
      traceId,
      operationId,
      rowCount: rows.length,
      resultCount: results.length,
      halted,
      createdCount: results.filter((result) => result.status === "CREATED")
        .length,
      updatedCount: results.filter((result) => result.status === "UPDATED")
        .length,
      dryRunCount: results.filter((result) => result.status === "DRY_RUN")
        .length,
      skippedCount: results.filter((result) => result.status === "SKIPPED")
        .length,
      errorCount: results.filter((result) => result.status === "ERROR").length,
      throttledCount: results.filter((result) => result.status === "THROTTLED")
        .length,
      refreshTokenRotated: Boolean(refreshed?.rotatedRefreshToken),
    });

    return NextResponse.json({
      ok: true,
      halted,
      results,
      rotatedRefreshToken: refreshed?.rotatedRefreshToken ?? "",
      traceId,
    });
  } catch (error) {
    const errorTraceId = readTraceId(error) || traceId;
    logEvent("error", "shiphero.bulk.request.failed", {
      traceId: errorTraceId,
      error: cleanMessage(error),
    });

    return NextResponse.json(
      {
        ok: false,
        error: cleanMessage(error),
        traceId: errorTraceId,
      },
      { status: 400 },
    );
  }
}

async function runLiveRow(
  accessToken: string,
  operationId: BulkOperationId,
  row: BulkInputRow,
  normalized: BulkPayload,
  options: BulkRunOptions,
  traceId: string,
  productCaseCache: ProductCaseCache,
): Promise<BulkResult> {
  if (normalized.operationId === "lots") {
    const payload = normalized.payload;

    if (options.skipExisting) {
      const existingLot = await findExistingLot(accessToken, payload, {
        traceId,
        operation: "bulk:find-existing-lot",
        rowNumber: row.rowNumber,
      });

      if (existingLot) {
        return {
          ...baseResult(operationId, row, normalized),
          status: "SKIPPED",
          requestId: "",
          complexity: "",
          message: "Already exists in ShipHero.",
          nextStep: successNextStep("SKIPPED"),
        };
      }
    }

    const response = await createLot(accessToken, payload, {
      traceId,
      operation: "bulk:create-lot",
      rowNumber: row.rowNumber,
    });

    return {
      ...baseResult(operationId, row, normalized),
      status: "CREATED",
      requestId: response.request_id ?? "",
      complexity: response.complexity ?? "",
      message: "Created.",
      nextStep: successNextStep("CREATED"),
    };
  }

  if (
    normalized.operationId === "location-pick-priority" ||
    normalized.operationId === "location-pickable" ||
    normalized.operationId === "location-sellable"
  ) {
    return runLocationUpdate(
      accessToken,
      operationId,
      row,
      normalized.payload,
      traceId,
    );
  }

  if (normalized.operationId === "product-case-barcodes") {
    const response = await updateProductCaseBarcode(
      accessToken,
      normalized.payload,
      {
        traceId,
        operation: "bulk:update-product-case-barcode",
        rowNumber: row.rowNumber,
      },
      productCaseCache,
    );
    const status: BulkStatus = response.skipped ? "SKIPPED" : "UPDATED";
    const message = response.skipped
      ? "Case barcode already exists with this quantity."
      : response.previousQuantity
        ? `Updated existing case barcode from quantity ${response.previousQuantity}.`
        : "Added case barcode.";

    return {
      ...baseResult(operationId, row, normalized),
      status,
      requestId: response.request_id ?? "",
      complexity: response.complexity ?? "",
      message,
      nextStep: successNextStep(status),
    };
  }

  throw new Error(`Unsupported operation: ${operationId}`);
}

async function runLocationUpdate(
  accessToken: string,
  operationId: BulkOperationId,
  row: BulkInputRow,
  payload: LocationUpdatePayload,
  traceId: string,
): Promise<BulkResult> {
  const resolved = await resolveLocation(accessToken, payload, {
    traceId,
    operation: "bulk:resolve-location",
    rowNumber: row.rowNumber,
  });
  const location = resolved.location;
  if (!location?.id) {
    throw new Error("ShipHero did not return a location.");
  }

  const base = {
    ...baseResult(operationId, row, {
      operationId: operationId as
        "location-pick-priority" | "location-pickable" | "location-sellable",
      payload,
    }),
    locationId: location.id,
    locationName: location.name ?? payload.location_name ?? "",
  };

  if (isSameLocationValue(location, payload)) {
    return {
      ...base,
      status: "SKIPPED",
      requestId: resolved.request_id ?? "",
      complexity: resolved.complexity ?? "",
      message: "Location already has the requested value.",
      nextStep: successNextStep("SKIPPED"),
    };
  }

  const response = await updateLocation(
    accessToken,
    buildLocationUpdateData(location.id, payload),
    {
      traceId,
      operation: "bulk:update-location",
      rowNumber: row.rowNumber,
    },
  );

  return {
    ...base,
    status: "UPDATED",
    requestId: response.request_id ?? "",
    complexity: response.complexity ?? "",
    message: "Updated.",
    nextStep: successNextStep("UPDATED"),
  };
}

function buildLocationUpdateData(
  locationId: string,
  payload: LocationUpdatePayload,
): {
  location_id: string;
  pick_priority?: number;
  pickable?: boolean;
  sellable?: boolean;
} {
  if (payload.field === "pick_priority") {
    return { location_id: locationId, pick_priority: Number(payload.value) };
  }
  if (payload.field === "pickable") {
    return { location_id: locationId, pickable: Boolean(payload.value) };
  }
  return { location_id: locationId, sellable: Boolean(payload.value) };
}

function isSameLocationValue(
  location: ShipHeroLocation,
  payload: LocationUpdatePayload,
): boolean {
  if (payload.field === "pick_priority") {
    return Number(location.pick_priority) === Number(payload.value);
  }
  if (payload.field === "pickable") {
    return Boolean(location.pickable) === Boolean(payload.value);
  }
  return Boolean(location.sellable) === Boolean(payload.value);
}

function normalizeOperationId(operationId?: BulkOperationId): BulkOperationId {
  const validIds: BulkOperationId[] = [
    "lots",
    "location-pick-priority",
    "location-pickable",
    "location-sellable",
    "product-case-barcodes",
  ];
  if (operationId && validIds.includes(operationId)) {
    return operationId;
  }
  return "lots";
}

function applySelectedCustomerAccount(
  normalized: BulkPayload,
  selectedCustomerAccountId: string,
): BulkPayload {
  if (!selectedCustomerAccountId) {
    return normalized;
  }

  if (normalized.operationId === "lots") {
    return {
      operationId: normalized.operationId,
      payload: {
        ...normalized.payload,
        customer_account_id:
          normalized.payload.customer_account_id || selectedCustomerAccountId,
      },
    };
  }

  if (normalized.operationId === "product-case-barcodes") {
    return {
      operationId: normalized.operationId,
      payload: {
        ...normalized.payload,
        customer_account_id:
          normalized.payload.customer_account_id || selectedCustomerAccountId,
      },
    };
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizedIdentifier(normalized: BulkPayload): string {
  if (normalized.operationId === "lots") {
    return `${normalized.payload.sku} / ${normalized.payload.name}`;
  }
  if (normalized.operationId === "product-case-barcodes") {
    return `${normalized.payload.sku} / ${normalized.payload.case_barcode}`;
  }
  return (
    normalized.payload.location_id || normalized.payload.location_name || ""
  );
}

function logRowCompleted(traceId: string, result: BulkResult) {
  logEvent("info", "shiphero.bulk.row.completed", {
    traceId,
    operationId: result.operationId,
    rowNumber: result.rowNumber,
    status: result.status,
    identifier: result.identifier ?? "",
    sku: result.sku ?? "",
    locationId: result.locationId ?? "",
    locationName: result.locationName ?? "",
    shipheroRequestId: result.requestId ?? "",
    complexity: result.complexity ?? "",
  });
}

function isThrottleError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "isThrottle" in error &&
    (error as { isThrottle?: boolean }).isThrottle,
  );
}

function readRequestId(error: unknown): string {
  if (error && typeof error === "object" && "requestId" in error) {
    return String((error as { requestId?: string }).requestId ?? "");
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
