import { cleanMessage, type LotPayload } from "@/lib/lots";

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

export type VerifiedAccount = {
  email: string;
  userId: string;
  accountId: string;
  requestId: string;
};

export type CreatedLot = {
  id?: string;
  legacy_id?: string;
  name?: string;
  sku?: string;
  expires_at?: string;
  is_active?: boolean;
};

export type CreateLotResponse = {
  request_id?: string;
  complexity?: string | number;
  lot?: CreatedLot;
};

export async function verifyRefreshToken(
  refreshToken: string,
  clientId?: string,
): Promise<VerifiedAccount> {
  const accessToken = await refreshAccessToken(refreshToken, clientId);
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
  });

  const mutation = response.data?.lot_create;
  if (!mutation?.lot) {
    throw new Error("ShipHero did not return a lot object.");
  }

  return mutation;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId?: string,
): Promise<string> {
  const cleaned = refreshToken.trim();
  if (!cleaned) {
    throw new Error("Enter a ShipHero refresh token.");
  }
  const cleanedClientId = normalizeClientId(clientId);

  const response = await fetchWithTimeout(SHIPHERO_TOKEN_ENDPOINT, {
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

  const text = await response.text();
  const body = parseJson<ShipHeroTokenResponse>(text, "ShipHero token refresh");
  if (!response.ok || !body.access_token) {
    throw new Error(
      `Could not refresh ShipHero access token: HTTP ${response.status} ${readOAuthMessage(
        body,
        text,
      )}`,
    );
  }

  return body.access_token;
}

function normalizeClientId(clientId?: string): string {
  const cleaned = (clientId ?? "").trim() || process.env.SHIPHERO_CLIENT_ID?.trim() || "";
  if (!cleaned) {
    throw new Error("Enter the ShipHero OAuth client ID that created this refresh token.");
  }
  return cleaned;
}

async function callShipHero<T>({
  accessToken,
  query,
  variables,
}: {
  accessToken: string;
  query: string;
  variables: Record<string, unknown>;
}): Promise<GraphQLResponse<T>> {
  const response = await fetchWithTimeout(SHIPHERO_API_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  const body = parseJson<GraphQLResponse<T>>(text, "ShipHero GraphQL");

  if (response.status === 401) {
    throw new Error("ShipHero rejected the access token with HTTP 401.");
  }
  if (response.status === 429) {
    const error = new Error("ShipHero rate limit reached. Wait before retrying.");
    Object.assign(error, { isThrottle: true });
    throw error;
  }
  if (!response.ok) {
    throw new Error(`ShipHero HTTP ${response.status}: ${cleanMessage(text)}`);
  }

  throwIfGraphQLErrors(body);
  return body;
}

function throwIfGraphQLErrors(response: GraphQLResponse<unknown>) {
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
