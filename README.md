# ShipHero Bulk Lot Creator

This is a Vercel-ready Next.js app for creating ShipHero lots from a CSV.

## What it does

- Uses a ShipHero refresh token, not a pasted access token.
- Verifies the token with ShipHero and shows the connected email, user ID, account ID, and request ID.
- Downloads a CSV template with the accepted columns.
- Uploads a CSV, validates rows in dry-run mode, then creates lots in live mode.
- Processes rows in small batches so the browser stays responsive.
- Exports a result CSV with created lot IDs, request IDs, and row-level errors.

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

## Deploy to Vercel

No environment variables are required for the first version. The operator pastes the refresh token into the app, the app sends it only to the server route for the ShipHero token exchange, and it is not stored by the app.

Recommended before customer use:

- Deploy the app behind Vercel authentication, password protection, or another access control layer.
- Run a dry check before switching off dry run.
- Confirm the verified account is the intended child account before live creation.
