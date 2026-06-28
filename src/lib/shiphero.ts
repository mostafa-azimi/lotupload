import type {
  LocationUpdatePayload,
  ProductCaseBarcodePayload,
} from "@/lib/bulk";
import { cleanMessage, type LotPayload } from "@/lib/lots";
import {
  attachTraceId,
  fingerprintSecret,
  logEvent,
  traceError,
} from "@/lib/logging";

const SHIPHERO_API_ENDPOINT = "https://public-api.shiphero.com/graphql";
const SHIPHERO_TOKEN_ENDPOINT = "https://login.shiphero.com/oauth/token";

type ShipHeroTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  message?: string;
};

type GraphQLErrorShape = {
  message?: string;
  code?: string | number;
  request_id?: string;
  time_remaining?: string | number;
  extensions?: {
    code?: string | number;
    request_id?: string;
    time_remaining?: string | number;
  };
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: GraphQLErrorShape[];
};

export type RefreshedAccessToken = {
  accessToken: string;
  rotatedRefreshToken: string;
  expiresIn?: number;
};

export type ShipHeroRequestContext = {
  traceId?: string;
  operation?: string;
  rowNumber?: number | "";
};

export type VerifiedAccount = {
  email: string;
  userId: string;
  accountId: string;
  accountLegacyId?: string | number;
  username?: string;
  is3pl: boolean;
  requestId: string;
  customers: ShipHeroCustomerAccount[];
  customerPageLimitReached?: boolean;
};

export type VerifyRefreshTokenResult = {
  account: VerifiedAccount;
  rotatedRefreshToken: string;
};

export type CreatedLot = {
  id?: string;
  legacy_id?: string;
  name?: string;
  sku?: string;
  expires_at?: string;
  is_active?: boolean;
};

export type ExistingLot = CreatedLot & {
  account_id?: string;
};

export type ShipHeroCustomerAccount = {
  id: string;
  legacyId?: string | number;
  email?: string;
  username?: string;
  displayName: string;
};

type CustomerAccountNode = {
  id?: string;
  legacy_id?: string | number;
  email?: string;
  username?: string;
};

type CustomerAccountsResponse = {
  account?: {
    request_id?: string;
    complexity?: string | number;
    data?: {
      customers?: {
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string;
        };
        edges?: Array<{
          node?: CustomerAccountNode;
        }>;
      };
    };
  };
};

type CustomerAccountNodeWithId = CustomerAccountNode & {
  id: string;
};

type ExistingLotsResponse = {
  expiration_lots?: {
    request_id?: string;
    complexity?: string | number;
    data?: {
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string;
      };
      edges?: Array<{
        node?: ExistingLot;
      }>;
    };
  };
};

export type CreateLotResponse = {
  request_id?: string;
  complexity?: string | number;
  lot?: CreatedLot;
};

export type ShipHeroLocation = {
  id?: string;
  legacy_id?: string | number;
  warehouse_id?: string;
  name?: string;
  pickable?: boolean;
  sellable?: boolean;
  pick_priority?: number;
};

export type LocationUpdateResponse = {
  request_id?: string;
  complexity?: string | number;
  location?: ShipHeroLocation;
};

export type ProductCase = {
  case_barcode?: string;
  case_quantity?: number;
};

export type ProductWithCases = {
  id?: string;
  name?: string;
  sku?: string;
  cases?: ProductCase[];
};

export type ProductCaseCache = Map<string, ProductWithCases>;

export type ProductCaseBarcodeResponse = {
  request_id?: string;
  complexity?: string | number;
  product?: ProductWithCases;
  skipped: boolean;
  previousQuantity?: number;
};

export async function verifyRefreshToken(
  refreshToken: string,
  clientId?: string,
  context: ShipHeroRequestContext = {},
): Promise<VerifyRefreshTokenResult> {
  const refreshed = await refreshAccessToken(refreshToken, clientId, {
    ...context,
    operation: context.operation ?? "verify-refresh-token",
  });
  const account = await probeAccount(refreshed.accessToken, context);

  return {
    account,
    rotatedRefreshToken: refreshed.rotatedRefreshToken,
  };
}

async function probeAccount(
  accessToken: string,
  context: ShipHeroRequestContext = {},
): Promise<VerifiedAccount> {
  const response = await callShipHero<{
    me?: {
      request_id?: string;
      data?: {
        id?: string;
        email?: string;
        account?: {
          id?: string;
        };
      };
    };
    account?: {
      request_id?: string;
      complexity?: string | number;
      data?: {
        id?: string;
        legacy_id?: string | number;
        email?: string;
        username?: string;
        is_3pl?: boolean;
      };
    };
  }>({
    accessToken,
    query: [
      "query TokenProbe {",
      "  me {",
      "    request_id",
      "    complexity",
      "    data {",
      "      id",
      "      email",
      "      account { id }",
      "    }",
      "  }",
      "  account {",
      "    request_id",
      "    complexity",
      "    data {",
      "      id",
      "      legacy_id",
      "      email",
      "      username",
      "      is_3pl",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {},
    operationName: "TokenProbe",
    context,
  });

  const me = response.data?.me;
  const meData = me?.data;
  const accountData = response.data?.account?.data;
  if (!meData && !accountData) {
    throw new Error("ShipHero did not return account details for this token.");
  }

  const is3pl = Boolean(accountData?.is_3pl);
  const customerResult = is3pl
    ? await listCustomerAccounts(accessToken, context)
    : { customers: [], pageLimitReached: false };

  return {
    email: accountData?.email ?? meData?.email ?? "",
    userId: meData?.id ?? "",
    accountId: accountData?.id ?? meData?.account?.id ?? "",
    accountLegacyId: accountData?.legacy_id,
    username: accountData?.username ?? "",
    is3pl,
    requestId: response.data?.account?.request_id ?? me?.request_id ?? "",
    customers: customerResult.customers,
    customerPageLimitReached: customerResult.pageLimitReached,
  };
}

async function listCustomerAccounts(
  accessToken: string,
  context: ShipHeroRequestContext = {},
): Promise<{
  customers: ShipHeroCustomerAccount[];
  pageLimitReached: boolean;
}> {
  const customers: ShipHeroCustomerAccount[] = [];
  let after: string | null = null;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page += 1) {
    const response: GraphQLResponse<CustomerAccountsResponse> =
      await callShipHero<CustomerAccountsResponse>({
        accessToken,
        query: [
          "query CustomerAccounts($after: String) {",
          "  account {",
          "    request_id",
          "    complexity",
          "    data {",
          "      customers(first: 100, after: $after) {",
          "        pageInfo { hasNextPage endCursor }",
          "        edges {",
          "          node {",
          "            id",
          "            legacy_id",
          "            email",
          "            username",
          "          }",
          "        }",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          after,
        },
        operationName: "CustomerAccounts",
        context: {
          ...context,
          operation: context.operation ?? "customer-accounts",
        },
      });

    const connection = response.data?.account?.data?.customers;
    const pageCustomers = (connection?.edges ?? [])
      .map((edge) => edge.node)
      .filter((node): node is CustomerAccountNodeWithId => Boolean(node?.id))
      .map((node) => ({
        id: node.id,
        legacyId: node.legacy_id,
        email: node.email,
        username: node.username,
        displayName: customerDisplayName(node),
      }));

    customers.push(...pageCustomers);

    if (!connection?.pageInfo?.hasNextPage) {
      return {
        customers: dedupeCustomerAccounts(customers),
        pageLimitReached: false,
      };
    }

    after = connection.pageInfo.endCursor ?? null;
    if (!after) {
      return {
        customers: dedupeCustomerAccounts(customers),
        pageLimitReached: true,
      };
    }
  }

  return {
    customers: dedupeCustomerAccounts(customers),
    pageLimitReached: true,
  };
}

export async function createLot(
  accessToken: string,
  payload: LotPayload,
  context: ShipHeroRequestContext = {},
): Promise<CreateLotResponse> {
  const response = await callShipHero<{
    lot_create?: CreateLotResponse;
  }>({
    accessToken,
    query: [
      "mutation CreateLot($data: CreateLotInput!) {",
      "  lot_create(data: $data) {",
      "    request_id",
      "    complexity",
      "    lot {",
      "      id",
      "      legacy_id",
      "      name",
      "      sku",
      "      expires_at",
      "      is_active",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {
      data: payload,
    },
    operationName: "CreateLot",
    context,
  });

  const mutation = response.data?.lot_create;
  if (!mutation?.lot) {
    throw new Error("ShipHero did not return a lot object.");
  }

  return mutation;
}

export async function findExistingLot(
  accessToken: string,
  payload: LotPayload,
  context: ShipHeroRequestContext = {},
): Promise<ExistingLot | null> {
  let after: string | null = null;
  const maxPages = 5;

  for (let page = 0; page < maxPages; page += 1) {
    const response: GraphQLResponse<ExistingLotsResponse> =
      await callShipHero<ExistingLotsResponse>({
        accessToken,
        query: [
          "query ExistingLots($sku: String, $after: String) {",
          "  expiration_lots(sku: $sku) {",
          "    request_id",
          "    complexity",
          "    data(first: 100, after: $after) {",
          "      pageInfo { hasNextPage endCursor }",
          "      edges {",
          "        node {",
          "          id",
          "          legacy_id",
          "          account_id",
          "          name",
          "          sku",
          "          expires_at",
          "          is_active",
          "        }",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          sku: payload.sku,
          after,
        },
        operationName: "ExistingLots",
        context,
      });

    const queryResult = response.data?.expiration_lots;
    const edges = queryResult?.data?.edges ?? [];
    const match = edges
      .map((edge) => edge.node)
      .find((lot): lot is ExistingLot =>
        Boolean(lot && isSameLot(payload, lot)),
      );

    if (match) {
      logEvent("info", "shiphero.lots.existing_found", {
        traceId: context.traceId,
        operation: context.operation,
        rowNumber: context.rowNumber ?? "",
        lotId: match.id ?? "",
        lotName: match.name ?? "",
        sku: match.sku ?? "",
        expiresAt: match.expires_at ?? "",
        shipheroRequestId: queryResult?.request_id ?? "",
      });
      return match;
    }

    if (!queryResult?.data?.pageInfo?.hasNextPage) {
      return null;
    }

    after = queryResult.data.pageInfo.endCursor ?? null;
    if (!after) {
      return null;
    }
  }

  logEvent("warn", "shiphero.lots.existing_lookup_cap_reached", {
    traceId: context.traceId,
    operation: context.operation,
    rowNumber: context.rowNumber ?? "",
    sku: payload.sku,
    maxPages,
  });

  return null;
}

export async function resolveLocation(
  accessToken: string,
  payload: LocationUpdatePayload,
  context: ShipHeroRequestContext = {},
): Promise<LocationUpdateResponse> {
  if (payload.location_id) {
    const response = await callShipHero<{
      location?: {
        request_id?: string;
        complexity?: string | number;
        data?: ShipHeroLocation;
      };
    }>({
      accessToken,
      query: [
        "query LocationById($id: String) {",
        "  location(id: $id) {",
        "    request_id",
        "    complexity",
        "    data {",
        "      id",
        "      legacy_id",
        "      warehouse_id",
        "      name",
        "      pickable",
        "      sellable",
        "      pick_priority",
        "    }",
        "  }",
        "}",
      ].join("\n"),
      variables: {
        id: payload.location_id,
      },
      operationName: "LocationById",
      context,
    });

    const result = response.data?.location;
    if (!result?.data?.id) {
      throw new Error(
        `Location not found for location_id ${payload.location_id}.`,
      );
    }

    return {
      request_id: result.request_id,
      complexity: result.complexity,
      location: result.data,
    };
  }

  if (!payload.location_name) {
    throw new Error("Missing required location_id or location_name.");
  }

  const response = await callShipHero<{
    locations?: {
      request_id?: string;
      complexity?: string | number;
      data?: {
        edges?: Array<{
          node?: ShipHeroLocation;
        }>;
      };
    };
  }>({
    accessToken,
    query: [
      "query LocationsByName($name: String, $warehouseId: String) {",
      "  locations(name: $name, warehouse_id: $warehouseId) {",
      "    request_id",
      "    complexity",
      "    data(first: 2) {",
      "      edges {",
      "        node {",
      "          id",
      "          legacy_id",
      "          warehouse_id",
      "          name",
      "          pickable",
      "          sellable",
      "          pick_priority",
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {
      name: payload.location_name,
      warehouseId: payload.warehouse_id ?? null,
    },
    operationName: "LocationsByName",
    context,
  });

  const result = response.data?.locations;
  const locations = (result?.data?.edges ?? [])
    .map((edge) => edge.node)
    .filter((location): location is ShipHeroLocation => Boolean(location?.id));

  if (!locations.length) {
    throw new Error(
      `Location not found for location_name ${payload.location_name}.`,
    );
  }
  if (locations.length > 1) {
    throw new Error(
      `Multiple locations matched ${payload.location_name}. Add location_id or warehouse_id to the CSV.`,
    );
  }

  return {
    request_id: result?.request_id,
    complexity: result?.complexity,
    location: locations[0],
  };
}

export async function updateLocation(
  accessToken: string,
  data: {
    location_id: string;
    pick_priority?: number;
    pickable?: boolean;
    sellable?: boolean;
  },
  context: ShipHeroRequestContext = {},
): Promise<LocationUpdateResponse> {
  const response = await callShipHero<{
    location_update?: LocationUpdateResponse;
  }>({
    accessToken,
    query: [
      "mutation UpdateLocation($data: UpdateLocationInput!) {",
      "  location_update(data: $data) {",
      "    request_id",
      "    complexity",
      "    location {",
      "      id",
      "      legacy_id",
      "      warehouse_id",
      "      name",
      "      pickable",
      "      sellable",
      "      pick_priority",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {
      data,
    },
    operationName: "UpdateLocation",
    context,
  });

  const mutation = response.data?.location_update;
  if (!mutation?.location?.id) {
    throw new Error("ShipHero did not return an updated location.");
  }

  return mutation;
}

export async function updateProductCaseBarcode(
  accessToken: string,
  payload: ProductCaseBarcodePayload,
  context: ShipHeroRequestContext = {},
  productCaseCache?: ProductCaseCache,
): Promise<ProductCaseBarcodeResponse> {
  const cacheKey = productCaseCacheKey(payload);
  const cachedProduct = productCaseCache?.get(cacheKey);
  const productResult = cachedProduct
    ? {
        product: cachedProduct,
      }
    : await getProductWithCases(accessToken, payload, {
        ...context,
        operation: context.operation ?? "product-case-lookup",
      });
  const product = productResult.product;
  if (!product?.sku) {
    throw new Error(`Product not found for sku ${payload.sku}.`);
  }
  productCaseCache?.set(cacheKey, product);

  const existingCases = product.cases ?? [];
  const existingCase = existingCases.find(
    (productCase) =>
      normalizeComparable(productCase.case_barcode) ===
      normalizeComparable(payload.case_barcode),
  );

  if (existingCase?.case_quantity === payload.case_quantity) {
    return {
      request_id: productResult.request_id,
      complexity: productResult.complexity,
      product,
      skipped: true,
      previousQuantity: existingCase.case_quantity,
    };
  }

  const cases = [
    ...existingCases
      .filter(
        (productCase) =>
          normalizeComparable(productCase.case_barcode) !==
          normalizeComparable(payload.case_barcode),
      )
      .map((productCase) => ({
        case_barcode: productCase.case_barcode ?? "",
        case_quantity: Number(productCase.case_quantity ?? 0),
      }))
      .filter(
        (productCase) =>
          productCase.case_barcode && productCase.case_quantity > 0,
      ),
    {
      case_barcode: payload.case_barcode,
      case_quantity: payload.case_quantity,
    },
  ];

  const response = await callShipHero<{
    product_update?: {
      request_id?: string;
      complexity?: string | number;
      product?: ProductWithCases;
    };
  }>({
    accessToken,
    query: [
      "mutation UpdateProductCases($data: UpdateProductInput!) {",
      "  product_update(data: $data) {",
      "    request_id",
      "    complexity",
      "    product {",
      "      id",
      "      name",
      "      sku",
      "      cases {",
      "        case_barcode",
      "        case_quantity",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {
      data: {
        sku: payload.sku,
        customer_account_id: payload.customer_account_id,
        cases,
      },
    },
    operationName: "UpdateProductCases",
    context,
  });

  const mutation = response.data?.product_update;
  if (!mutation?.product?.sku) {
    throw new Error("ShipHero did not return an updated product.");
  }
  productCaseCache?.set(cacheKey, mutation.product);

  return {
    ...mutation,
    skipped: false,
    previousQuantity: existingCase?.case_quantity,
  };
}

function productCaseCacheKey(payload: ProductCaseBarcodePayload): string {
  return [payload.customer_account_id ?? "", payload.sku]
    .map(normalizeComparable)
    .join("|");
}

async function getProductWithCases(
  accessToken: string,
  payload: ProductCaseBarcodePayload,
  context: ShipHeroRequestContext = {},
): Promise<{
  request_id?: string;
  complexity?: string | number;
  product?: ProductWithCases;
}> {
  const response = await callShipHero<{
    product?: {
      request_id?: string;
      complexity?: string | number;
      data?: ProductWithCases;
    };
  }>({
    accessToken,
    query: [
      "query ProductCases($sku: String, $customerAccountId: String) {",
      "  product(sku: $sku, customer_account_id: $customerAccountId) {",
      "    request_id",
      "    complexity",
      "    data {",
      "      id",
      "      name",
      "      sku",
      "      cases {",
      "        case_barcode",
      "        case_quantity",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {
      sku: payload.sku,
      customerAccountId: payload.customer_account_id ?? null,
    },
    operationName: "ProductCases",
    context,
  });

  const result = response.data?.product;
  return {
    request_id: result?.request_id,
    complexity: result?.complexity,
    product: result?.data,
  };
}

function isSameLot(payload: LotPayload, lot: ExistingLot): boolean {
  const sameName =
    normalizeComparable(payload.name) === normalizeComparable(lot.name);
  const sameSku =
    normalizeComparable(payload.sku) === normalizeComparable(lot.sku);

  if (!sameName || !sameSku) {
    return false;
  }

  if (payload.customer_account_id) {
    const lotAccountId = normalizeComparable(lot.account_id);
    if (
      !lotAccountId ||
      lotAccountId !== normalizeComparable(payload.customer_account_id)
    ) {
      return false;
    }
  }

  if (!payload.expires_at) {
    return true;
  }

  return (
    normalizeDateForCompare(payload.expires_at) ===
    normalizeDateForCompare(lot.expires_at)
  );
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId?: string,
  context: ShipHeroRequestContext = {},
): Promise<RefreshedAccessToken> {
  const cleaned = refreshToken.trim();
  if (!cleaned) {
    throw new Error("Enter a ShipHero refresh token.");
  }
  const cleanedClientId = normalizeClientId(clientId);

  logEvent("info", "shiphero.oauth.refresh.start", {
    traceId: context.traceId,
    operation: context.operation,
    clientIdFingerprint: fingerprintSecret(cleanedClientId),
    refreshTokenFingerprint: fingerprintSecret(cleaned),
    hasEnvClientIdFallback: Boolean(process.env.SHIPHERO_CLIENT_ID?.trim()),
  });

  let response: Response;
  try {
    response = await fetchWithTimeout(SHIPHERO_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cleanedClientId,
        refresh_token: cleaned,
      }),
    });
  } catch (error) {
    logEvent("error", "shiphero.oauth.refresh.fetch_failed", {
      traceId: context.traceId,
      operation: context.operation,
      error: cleanMessage(error),
    });
    throw attachTraceId(error, context.traceId);
  }

  const text = await response.text();
  let body: ShipHeroTokenResponse;
  try {
    body = parseJson<ShipHeroTokenResponse>(text, "ShipHero token refresh");
  } catch (error) {
    logEvent("warn", "shiphero.oauth.refresh.non_json_response", {
      traceId: context.traceId,
      operation: context.operation,
      httpStatus: response.status,
      responsePreview: text,
    });
    throw attachTraceId(error, context.traceId);
  }

  const oauthMessage = readOAuthMessage(body, text);
  logEvent(
    response.ok && body.access_token ? "info" : "warn",
    "shiphero.oauth.refresh.response",
    {
      traceId: context.traceId,
      operation: context.operation,
      httpStatus: response.status,
      ok: response.ok,
      hasAccessToken: Boolean(body.access_token),
      hasNewRefreshToken: Boolean(body.refresh_token),
      expiresIn: body.expires_in ?? null,
      oauthError: body.error ?? "",
      oauthMessage,
      bodyKeys: Object.keys(body),
    },
  );

  if (!response.ok || !body.access_token) {
    throw traceError(
      `Could not refresh ShipHero access token: HTTP ${response.status} ${readOAuthMessage(
        body,
        text,
      )}`,
      context.traceId,
    );
  }

  return {
    accessToken: body.access_token,
    rotatedRefreshToken: body.refresh_token ?? "",
    expiresIn: body.expires_in,
  };
}

function normalizeClientId(clientId?: string): string {
  const cleaned =
    (clientId ?? "").trim() || process.env.SHIPHERO_CLIENT_ID?.trim() || "";
  if (!cleaned) {
    throw new Error(
      "Enter the ShipHero OAuth client ID that created this refresh token.",
    );
  }
  return cleaned;
}

function normalizeComparable(value?: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function customerDisplayName(customer: {
  id?: string;
  legacy_id?: string | number;
  email?: string;
  username?: string;
}): string {
  return (
    customer.username?.trim() ||
    customer.email?.trim() ||
    (customer.legacy_id ? `Legacy ${customer.legacy_id}` : "") ||
    customer.id?.trim() ||
    "Customer account"
  );
}

function dedupeCustomerAccounts(
  customers: ShipHeroCustomerAccount[],
): ShipHeroCustomerAccount[] {
  const seen = new Set<string>();
  return customers.filter((customer) => {
    if (seen.has(customer.id)) {
      return false;
    }
    seen.add(customer.id);
    return true;
  });
}

function normalizeDateForCompare(value?: string): string {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isNaN(timestamp)
    ? normalizeComparable(value)
    : String(timestamp);
}

async function callShipHero<T>({
  accessToken,
  query,
  variables,
  operationName,
  context,
}: {
  accessToken: string;
  query: string;
  variables: Record<string, unknown>;
  operationName: string;
  context: ShipHeroRequestContext;
}): Promise<GraphQLResponse<T>> {
  logEvent("info", "shiphero.graphql.request.start", {
    traceId: context.traceId,
    operation: context.operation,
    operationName,
    rowNumber: context.rowNumber ?? "",
  });

  const response = await fetchWithTimeout(SHIPHERO_API_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let body: GraphQLResponse<T>;
  try {
    body = parseJson<GraphQLResponse<T>>(text, "ShipHero GraphQL");
  } catch (error) {
    logEvent("warn", "shiphero.graphql.non_json_response", {
      traceId: context.traceId,
      operation: context.operation,
      operationName,
      httpStatus: response.status,
      responsePreview: text,
    });
    throw attachTraceId(error, context.traceId);
  }

  logEvent(
    response.ok && !body.errors?.length ? "info" : "warn",
    "shiphero.graphql.response",
    {
      traceId: context.traceId,
      operation: context.operation,
      operationName,
      rowNumber: context.rowNumber ?? "",
      httpStatus: response.status,
      ok: response.ok,
      hasGraphQLErrors: Boolean(body.errors?.length),
      graphQLErrorCount: body.errors?.length ?? 0,
    },
  );

  if (response.status === 401) {
    throw traceError(
      "ShipHero rejected the access token with HTTP 401.",
      context.traceId,
    );
  }
  if (response.status === 429) {
    const error = new Error(
      "ShipHero rate limit reached. Wait before retrying.",
    );
    Object.assign(error, { isThrottle: true, traceId: context.traceId });
    throw error;
  }
  if (!response.ok) {
    throw traceError(
      `ShipHero HTTP ${response.status}: ${cleanMessage(text)}`,
      context.traceId,
    );
  }

  throwIfGraphQLErrors(body, context.traceId);
  return body;
}

function throwIfGraphQLErrors(
  response: GraphQLResponse<unknown>,
  traceId?: string,
) {
  if (!response.errors?.length) {
    return;
  }

  const first = response.errors[0] ?? {};
  const extensions = first.extensions ?? {};
  const code = first.code ?? extensions.code ?? "";
  const requestId = first.request_id ?? extensions.request_id ?? "";
  const timeRemaining = first.time_remaining ?? extensions.time_remaining ?? "";
  const messageParts: string[] = [];

  if (code) {
    messageParts.push(`code ${code}`);
  }
  messageParts.push(first.message ?? "GraphQL error");
  if (requestId) {
    messageParts.push(`request_id ${requestId}`);
  }
  if (timeRemaining) {
    messageParts.push(`wait ${timeRemaining}`);
  }

  const error = new Error(messageParts.join(" | "));
  Object.assign(error, {
    requestId,
    isThrottle: String(code) === "30",
    traceId,
  });
  throw error;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = 25000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("ShipHero request timed out after 25 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson<T>(text: string, label: string): T {
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new Error(`${label} returned a non-JSON response.`);
  }
}

function readOAuthMessage(
  body: ShipHeroTokenResponse,
  fallbackText: string,
): string {
  return (
    body.error_description ??
    body.error ??
    body.message ??
    cleanMessage(fallbackText) ??
    "Request failed."
  );
}
