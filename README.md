# ShipHero Bulk Updater

Vercel-ready Next.js app for safe ShipHero bulk CSV updates.

## Tools

- Create lots and expirations in bulk.
- Update location pick priority in bulk.
- Set locations pickable or non-pickable in bulk.
- Set locations sellable or non-sellable in bulk.
- Add or update product case barcodes in bulk.

## Login

The app uses refresh-token login only. Operators enter:

- ShipHero OAuth client ID
- ShipHero refresh token

The server refreshes the token through ShipHero, verifies the account with `me` and `account`, and uses the short-lived access token only inside server routes. Pasted access-token login is not part of the app.

Refresh tokens must be refreshed with the same OAuth client ID that created them. ShipHero can rotate refresh tokens during a refresh; when that happens, the app updates the current browser session.

## Brand And 3PL Profiles

Saved profiles live in the browser's local storage. The app does not store refresh tokens server-side.

Brand accounts:

1. Paste the client ID and refresh token.
2. Click Connect.
3. Confirm the connected brand account.
4. The profile is saved in this browser.

3PL accounts:

1. Paste the 3PL client ID and refresh token.
2. Click Connect.
3. Choose the ShipHero child account from the dropdown, or paste the child account ID manually.
4. Enter a friendly child account name.
5. Click Save profile.
6. Next time, choose that child profile from Saved connection.

Lots and product case barcode updates use the selected child account by sending `customer_account_id` when the CSV row does not already include one. Location tools ignore the child account profile because ShipHero's `UpdateLocationInput` does not include `customer_account_id`; those updates stay scoped to the connected 3PL/location account.

## CSV Templates

Use the Templates button in the app header, or open `/templates`, to download each CSV format.

Lots:

```csv
sku,name,expires_at,is_active,customer_account_id,notes
SKU-12345,LOT-2026-001,2026-12-31,true,,
```

Location pick priority:

```csv
location_id,location_name,warehouse_id,pick_priority,notes
,A-01-01,V2FyZWhvdXNlOjEyMzQ=,10,
```

Location pickable:

```csv
location_id,location_name,warehouse_id,pickable,notes
,A-01-01,V2FyZWhvdXNlOjEyMzQ=,true,
```

Location sellable:

```csv
location_id,location_name,warehouse_id,sellable,notes
,A-01-01,V2FyZWhvdXNlOjEyMzQ=,false,
```

Product case barcodes:

```csv
sku,case_barcode,case_quantity,customer_account_id,notes
SKU-12345,CASE-SKU-12345-12,12,,
```

For location tools, `location_id` is safest. If using `location_name`, include `warehouse_id` when possible.

## Error Handling

Every result row includes:

- status
- ShipHero request ID when available
- message
- next_step

Recommended retry flow:

1. Run dry mode first.
2. Run live mode after confirming the connected account.
3. If errors happen, download the results CSV.
4. Filter to `ERROR` or `THROTTLED`.
5. Follow the `next_step` column.
6. Rerun only the fixed rows.

Live runs are idempotent where possible:

- Lots can skip existing matching lots.
- Location updates skip rows already set to the requested value.
- Product case barcode updates merge with existing cases and skip exact matches.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy To Vercel

No environment variables are required for the default setup. The operator enters the OAuth client ID and refresh token in the app, and the app does not store them server-side.

Recommended before customer use:

- Deploy behind Vercel authentication, password protection, or another access control layer.
- Run dry mode before live mode.
- Confirm the verified account is the intended child account before live updates.

## Logs

Every verify and bulk request gets a trace ID. The UI shows the latest trace ID, and Vercel logs include entries prefixed with:

```text
[shiphero-bulk-updater]
```

Logs include operation ID, row counts, safe token/client fingerprints, HTTP status, ShipHero request IDs, row status, and error summaries. Refresh tokens and access tokens are not logged.
