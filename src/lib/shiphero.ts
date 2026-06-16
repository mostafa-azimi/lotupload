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
  requestId: string;
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

export async function verifyAccessToken(
  accessToken: string,
  context: ShipHeroRequestContext = {},
): Promise<VerifiedAccount> {
  const cleaned = readProvidedAccessToken(accessToken, context);
  return probeAccount(cleaned, context);
}

export function readProvidedAccessToken(
  accessToken: string,
  context: ShipHeroRequestContext = {},
): string {
  const cleaned = normalizeAccessToken(accessToken);
  logEvent("info", "shiphero.oauth.access_token.provided", {
    traceId: context.traceId,
    operation: context.operation,
    accessTokenFingerprint: fingerprintSecret(cleaned),
  });
  return cleaned;
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
      "}",
    ].join("\n"),
    variables: {},
    operationName: "TokenProbe",
    context,
  });

  const me = response.data?.me;
  const data = me?.data;
  if (!data) {
    throw new Error("ShipHero did not return account details for this token.");
  }

  return {
    email: data.email ?? "",
    userId: data.id ?? "",
    accountId: data.account?.id ?? "",
    requestId: me?.request_id ?? "",
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
    const response: GraphQLResponse<ExistingLotsResponse> = await callShipHero<ExistingLotsResponse>({
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
      .find((lot): lot is ExistingLot => Boolean(lot && isSameLot(payload, lot)));

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

function isSameLot(payload: LotPayload, lot: ExistingLot): boolean {
  const sameName = normalizeComparable(payload.name) === normalizeComparable(lot.name);
  const sameSku = normalizeComparable(payload.sku) === normalizeComparable(lot.sku);

  if (!sameName || !sameSku) {
    return false;
  }

  if (!payload.expires_at) {
    return true;
  }

  return normalizeDateForCompare(payload.expires_at) === normalizeDateForCompare(lot.expires_at);
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
  logEvent(response.ok && body.access_token ? "info" : "warn", "shiphero.oauth.refresh.response", {
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
  });

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
  const cleaned = (clientId ?? "").trim() || process.env.SHIPHERO_CLIENT_ID?.trim() || "";
  if (!cleaned) {
    throw new Error("Enter the ShipHero OAuth client ID that created this refresh token.");
  }
  return cleaned;
}

function normalizeAccessToken(accessToken?: string): string {
  const cleaned = (accessToken ?? "").trim();
  if (!cleaned) {
    throw new Error("Enter a ShipHero access token.");
  }
  return cleaned;
}

function normalizeComparable(value?: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeDateForCompare(value?: string): string {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isNaN(timestamp) ? normalizeComparable(value) : String(timestamp);
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

  logEvent(response.ok && !body.errors?.length ? "info" : "warn", "shiphero.graphql.response", {
    traceId: context.traceId,
    operation: context.operation,
    operationName,
    rowNumber: context.rowNumber ?? "",
    httpStatus: response.status,
    ok: response.ok,
    hasGraphQLErrors: Boolean(body.errors?.length),
    graphQLErrorCount: body.errors?.length ?? 0,
  });

  if (response.status === 401) {
    throw traceError("ShipHero rejected the access token with HTTP 401.", context.traceId);
  }
  if (response.status === 429) {
    const error = new Error("ShipHero rate limit reached. Wait before retrying.");
    Object.assign(error, { isThrottle: true, traceId: context.traceId });
    throw error;
  }
  if (!response.ok) {
    throw traceError(`ShipHero HTTP ${response.status}: ${cleanMessage(text)}`, context.traceId);
  }

  throwIfGraphQLErrors(body, context.traceId);
  return body;
}

function throwIfGraphQLErrors(response: GraphQLResponse<unknown>, traceId?: string) {
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

function readOAuthMessage(body: ShipHeroTokenResponse, fallbackText: string): string {
  return (
    body.error_description ??
    body.error ??
    body.message ??
    cleanMessage(fallbackText) ??
    "Request failed."
  );
}
