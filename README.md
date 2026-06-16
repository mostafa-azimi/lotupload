# ShipHero Bulk Lot Creator

This is a Vercel-ready Next.js app for creating ShipHero lots from a CSV.

## What it does

- Uses a ShipHero refresh token, not a pasted access token.
- Sends the matching ShipHero OAuth client ID during token refresh.
- Keeps the browser session updated when ShipHero rotates the refresh token.
- Can use a direct ShipHero access token for short emergency runs.
- Skips rows already marked as created in the current browser session when rerunning the same CSV.
- Verifies the token with ShipHero and shows the connected email, user ID, account ID, and request ID.
- Downloads a CSV template with the accepted columns.
- Uploads a CSV, validates rows in dry-run mode, then creates lots in live mode.
- Processes rows in small batches so the browser stays responsive.
- Exports a result CSV with created lot IDs, request IDs, and row-level errors.
- Writes safe server logs with trace IDs for OAuth refresh, account verification, and lot creation.

## CSV columns

Required:

- `name`
- `sku`

Optional:

- `expires_at`
- `is_active`
- `customer_account_id`
- `notes`

`customer_account_id` is usually blank when the refresh token belongs to the child account. `notes` is included for operator reference and is not sent to ShipHero.

Accepted date examples:

- `2026-12-31`
- `12/31/2026`
- `2026-12-31 13:30`
- `2026-12-31T13:30:00`

Accepted boolean examples:

- true: `true`, `yes`, `y`, `1`, `active`, `enabled`
- false: `false`, `no`, `n`, `0`, `inactive`, `disabled`

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## ShipHero OAuth client ID

Refresh tokens must be refreshed with the same OAuth client ID that created them. The app does not hardcode a client ID. Paste the matching client ID into the token panel before verifying the token.

If every operator will use the same OAuth client, you can optionally set `SHIPHERO_CLIENT_ID` in Vercel as a server-side fallback. Otherwise, leave it unset and have each operator enter the client ID for their refresh token.

ShipHero can return a new refresh token during refresh. When that happens, the app updates the token field in the current browser session and uses the newest token for later batches.

## Access token mode

Access token mode skips the refresh-token exchange and sends the pasted access token directly to ShipHero GraphQL. It is useful when a customer needs an immediate one-time run and the refresh token is blocked. Access tokens expire, so refresh token mode is better for repeat use.

## Retrying after a partial upload

If a live upload partially succeeds and then errors, keep the page open. The app remembers rows that returned `CREATED` in that browser session and skips them on the next live run, so rerunning the same CSV retries the remaining rows only.

If the page was refreshed or closed, use the results CSV to remove rows with `CREATED` before retrying. The app cannot know what was created in a previous browser session unless ShipHero rejects duplicates.

## Deploy to Vercel

No environment variables are required for the default setup. The operator pastes the refresh token into the app, the app sends it only to the server route for the ShipHero token exchange, and it is not stored by the app.

Recommended before customer use:

- Deploy the app behind Vercel authentication, password protection, or another access control layer.
- Run a dry check before switching off dry run.
- Confirm the verified account is the intended child account before live creation.

## Debug logs

Every verify/upload request gets a trace ID. The UI shows the latest trace ID, and Vercel logs include entries prefixed with:

```text
[shiphero-lot-upload]
```

The logs include HTTP status, OAuth error text, row counts, ShipHero request IDs when available, and safe fingerprints for the refresh token/client ID. They do not log refresh tokens or access tokens.
