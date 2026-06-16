"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Download,
  FileCheck2,
  KeyRound,
  Loader2,
  Play,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import {
  normalizeLotRow,
  parseCsv,
  SAMPLE_CSV,
  toResultsCsv,
  type LotInputRow,
  type LotResult,
} from "@/lib/lots";

type VerifiedAccount = {
  email: string;
  userId: string;
  accountId: string;
  requestId: string;
};

type RunState = "idle" | "checking" | "running" | "done" | "error";
type AuthMode = "refresh" | "access";

const BATCH_SIZE = 20;

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("refresh");
  const [clientId, setClientId] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [account, setAccount] = useState<VerifiedAccount | null>(null);
  const [rows, setRows] = useState<LotInputRow[]>([]);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [stopOnError, setStopOnError] = useState(true);
  const [skipExisting, setSkipExisting] = useState(true);
  const [throttleMs, setThrottleMs] = useState(150);
  const [state, setState] = useState<RunState>("idle");
  const [statusText, setStatusText] = useState("Waiting for a CSV.");
  const [lastTraceId, setLastTraceId] = useState("");
  const [results, setResults] = useState<LotResult[]>([]);
  const [createdLotKeys, setCreatedLotKeys] = useState<Set<string>>(new Set());
  const [processed, setProcessed] = useState(0);

  const counts = useMemo(() => {
    return results.reduce(
      (acc, result) => {
        acc.total += 1;
        if (result.status === "CREATED") acc.created += 1;
        if (result.status === "DRY_RUN") acc.validated += 1;
        if (result.status === "SKIPPED") acc.skipped += 1;
        if (result.status === "ERROR") acc.errors += 1;
        if (result.status === "THROTTLED") acc.throttled += 1;
        return acc;
      },
      { total: 0, created: 0, validated: 0, skipped: 0, errors: 0, throttled: 0 },
    );
  }, [results]);

  const canRun = rows.length > 0 && state !== "checking" && state !== "running";
  const liveRunBlocked = !dryRun && !account;
  const authReady =
    authMode === "access"
      ? Boolean(accessToken.trim())
      : Boolean(clientId.trim() && refreshToken.trim());
  const progressPercent = rows.length ? Math.round((processed / rows.length) * 100) : 0;

  function updateAuthMode(value: AuthMode) {
    setAuthMode(value);
    setAccount(null);
    setState("idle");
    setLastTraceId("");
    setStatusText(
      value === "access"
        ? "Access token mode selected. Verify account before live upload."
        : "Refresh token mode selected. Enter client ID and refresh token.",
    );
  }

  function resetToken(value: string) {
    setRefreshToken(value);
    setAccount(null);
    setState("idle");
    setStatusText(
      value.trim()
        ? "Token entered. Enter the matching OAuth client ID, then verify account."
        : "Waiting for a CSV.",
    );
  }

  function updateAccessToken(value: string) {
    setAccessToken(value);
    setAccount(null);
    setState("idle");
    setStatusText(value.trim() ? "Access token entered. Verify account before live upload." : "Waiting for a CSV.");
  }

  function updateClientId(value: string) {
    setClientId(value);
    setAccount(null);
    setState("idle");
    setStatusText("Client ID changed. Verify account before live upload.");
  }

  async function verifyToken() {
    if (authMode === "refresh" && !clientId.trim()) {
      setState("error");
      setStatusText("Enter the ShipHero OAuth client ID for this refresh token.");
      return;
    }
    if (authMode === "refresh" && !refreshToken.trim()) {
      setState("error");
      setStatusText("Paste a ShipHero refresh token first.");
      return;
    }
    if (authMode === "access" && !accessToken.trim()) {
      setState("error");
      setStatusText("Paste a ShipHero access token first.");
      return;
    }

    setState("checking");
    setStatusText("Checking ShipHero account...");
    setAccount(null);

    try {
      const response = await fetchWithTimeout("/api/shiphero/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMode, refreshToken, accessToken, clientId }),
      });
      const body = await response.json();
      setLastTraceId(body.traceId ?? "");

      if (!response.ok || !body.ok) {
        throw new Error(formatApiError(body.error || "Token check failed.", body.traceId));
      }

      if (authMode === "refresh" && body.rotatedRefreshToken) {
        setRefreshToken(body.rotatedRefreshToken);
      }

      setAccount(body.account);
      setState("idle");
      setStatusText(
        body.rotatedRefreshToken
          ? "Connected. Refresh token updated for this session."
          : authMode === "access"
            ? "Connected with access token. Confirm the account before running live mode."
            : "Connected. Confirm the account before running live mode.",
      );
    } catch (error) {
      setState("error");
      setStatusText(readError(error));
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setResults([]);
    setProcessed(0);

    try {
      const text = await file.text();
      loadCsvText(text, file.name);
    } catch (error) {
      setRows([]);
      setState("error");
      setStatusText(readError(error));
    }
  }

  function loadPastedCsv() {
    loadCsvText(csvText, "Pasted CSV");
  }

  function loadCsvText(text: string, sourceName: string) {
    try {
      const parsedRows = parseCsv(text);
      setRows(parsedRows);
      setFileName(sourceName);
      setResults([]);
      setProcessed(0);
      setState("idle");
      setStatusText(`Loaded ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setRows([]);
      setState("error");
      setStatusText(readError(error));
    }
  }

  async function runUpload() {
    if (!canRun) return;
    if (liveRunBlocked) {
      setState("error");
      setStatusText("Verify the refresh token account before running live mode.");
      return;
    }

    setState("running");
    const skippedResults = dryRun ? [] : buildSkippedResults(rows, createdLotKeys, account?.accountId);
    const rowsToRun = dryRun
      ? rows
      : rows.filter((row) => !createdLotKeys.has(lotRowKey(row, account?.accountId)));
    setResults(skippedResults);
    setProcessed(skippedResults.length);
    setStatusText(dryRun ? "Validating CSV rows..." : "Creating ShipHero lots...");

    if (!dryRun && skippedResults.length && !rowsToRun.length) {
      setState("done");
      setStatusText("All rows were skipped because they were already created in this browser session.");
      return;
    }

    const nextResults: LotResult[] = [...skippedResults];
    let activeRefreshToken = refreshToken;

    try {
      for (let start = 0; start < rowsToRun.length; start += BATCH_SIZE) {
        const batch = rowsToRun.slice(start, start + BATCH_SIZE);
        const response = await fetchWithTimeout("/api/shiphero/lots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authMode,
            refreshToken: activeRefreshToken,
            accessToken,
            clientId,
            rows: batch,
            options: {
              dryRun,
              stopOnError,
              skipExisting,
              throttleMs,
            },
          }),
        });
        const body = await response.json();
        setLastTraceId(body.traceId ?? "");

        if (!response.ok || !body.ok) {
          throw new Error(formatApiError(body.error || "Upload failed.", body.traceId));
        }

        if (authMode === "refresh" && body.rotatedRefreshToken) {
          activeRefreshToken = body.rotatedRefreshToken;
          setRefreshToken(body.rotatedRefreshToken);
        }

        nextResults.push(...body.results);
        rememberCreatedLots(body.results, rowsToRun, account?.accountId, setCreatedLotKeys);
        setResults([...nextResults]);
        setProcessed(Math.min(skippedResults.length + start + batch.length, rows.length));

        if (body.halted) {
          setState("error");
          setStatusText("Stopped because ShipHero returned an error.");
          return;
        }
      }

      setState("done");
      setStatusText(
        dryRun
          ? "Dry run finished. No lots were created."
          : skippedResults.length
            ? `Live run finished. Skipped ${skippedResults.length} row${skippedResults.length === 1 ? "" : "s"} already created in this browser session.`
            : "Live run finished.",
      );
    } catch (error) {
      setState("error");
      setStatusText(readError(error));
    }
  }

  function clearFile() {
    setRows([]);
    setResults([]);
    setProcessed(0);
    setFileName("");
    setStatusText("Waiting for a CSV.");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function downloadTemplate() {
    downloadText("shiphero-lot-upload-template.csv", SAMPLE_CSV);
  }

  function downloadResults() {
    downloadText("shiphero-lot-upload-results.csv", toResultsCsv(results));
  }

  return (
    <main className="min-h-screen bg-stone-50 text-zinc-950">
      <section className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-teal-700">ShipHero bulk lot creator</p>
              <h1 className="mt-1 text-2xl font-semibold text-zinc-950 sm:text-3xl">
                Create lots from a CSV
              </h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" type="button" onClick={downloadTemplate}>
                <Download className="size-4" aria-hidden />
                Template CSV
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={runUpload}
                disabled={!canRun || liveRunBlocked}
                title={liveRunBlocked ? "Verify the account before live mode." : "Run upload"}
              >
                {state === "running" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-4" aria-hidden />
                )}
                {dryRun ? "Run dry check" : "Create lots"}
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="CSV rows" value={rows.length} tone="neutral" />
            <Metric label={dryRun ? "Validated" : "Created"} value={dryRun ? counts.validated : counts.created} tone="good" />
            <Metric label="Errors" value={counts.errors} tone="bad" />
            <Metric label={counts.skipped ? "Skipped" : "Throttled"} value={counts.skipped || counts.throttled} tone="warn" />
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr] lg:px-8">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Refresh Token" icon={<KeyRound className="size-4" aria-hidden />}>
            <div className="mb-3 grid grid-cols-2 gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-1">
              <button
                className={authMode === "refresh" ? "btn-primary" : "btn-ghost"}
                type="button"
                onClick={() => updateAuthMode("refresh")}
              >
                Refresh token
              </button>
              <button
                className={authMode === "access" ? "btn-primary" : "btn-ghost"}
                type="button"
                onClick={() => updateAuthMode("access")}
              >
                Access token
              </button>
            </div>

            {authMode === "refresh" ? (
              <>
                <label className="field-label" htmlFor="client-id">
                  ShipHero OAuth client ID
                </label>
                <input
                  id="client-id"
                  className="mb-3 h-10 w-full rounded-md border border-zinc-300 bg-white px-3 font-mono text-sm outline-none ring-teal-600 transition focus:ring-2"
                  placeholder="Paste OAuth client ID for this refresh token"
                  value={clientId}
                  onChange={(event) => updateClientId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <label className="field-label" htmlFor="refresh-token">
                  ShipHero refresh token
                </label>
                <textarea
                  id="refresh-token"
                  className="min-h-28 w-full resize-y rounded-md border border-zinc-300 bg-white p-3 font-mono text-sm outline-none ring-teal-600 transition focus:ring-2"
                  placeholder="Paste refresh token"
                  value={refreshToken}
                  onChange={(event) => resetToken(event.target.value)}
                  spellCheck={false}
                />
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="access-token">
                  ShipHero access token
                </label>
                <textarea
                  id="access-token"
                  className="min-h-28 w-full resize-y rounded-md border border-zinc-300 bg-white p-3 font-mono text-sm outline-none ring-teal-600 transition focus:ring-2"
                  placeholder="Paste access token"
                  value={accessToken}
                  onChange={(event) => updateAccessToken(event.target.value)}
                  spellCheck={false}
                />
                <div className="mt-2 text-xs text-zinc-600">
                  Access tokens expire. Use this for quick runs, then switch back to refresh token mode for repeat use.
                </div>
              </>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn-secondary"
                type="button"
                onClick={verifyToken}
                disabled={state === "checking" || !authReady}
              >
                {state === "checking" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="size-4" aria-hidden />
                )}
                Verify account
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => (authMode === "access" ? updateAccessToken("") : resetToken(""))}
                disabled={authMode === "access" ? !accessToken : !refreshToken}
              >
                <Trash2 className="size-4" aria-hidden />
                Clear
              </button>
            </div>

            {account ? (
              <div className="mt-4 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-950">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="size-4" aria-hidden />
                  Connected account
                </div>
                <dl className="mt-3 grid gap-2">
                  <AccountLine label="Email" value={account.email || "Not returned"} />
                  <AccountLine label="User ID" value={account.userId || "Not returned"} />
                  <AccountLine label="Account ID" value={account.accountId || "Not returned"} />
                  <AccountLine label="Request ID" value={account.requestId || "Not returned"} />
                </dl>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>Live mode stays locked until the token is verified.</span>
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Run Settings" icon={<FileCheck2 className="size-4" aria-hidden />}>
            <div className="space-y-3">
              <Toggle
                checked={dryRun}
                label="Dry run"
                onChange={setDryRun}
              />
              <Toggle
                checked={stopOnError}
                label="Stop on first error"
                onChange={setStopOnError}
              />
              <Toggle
                checked={skipExisting}
                label="Skip existing in ShipHero"
                onChange={setSkipExisting}
              />
              <label className="field-label" htmlFor="throttle">
                Delay between live requests
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="throttle"
                  className="h-10 w-28 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none ring-teal-600 transition focus:ring-2"
                  min={0}
                  max={2000}
                  step={50}
                  type="number"
                  value={throttleMs}
                  onChange={(event) => setThrottleMs(Number(event.target.value))}
                />
                <span className="text-sm text-zinc-600">ms</span>
              </div>
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="CSV Upload" icon={<Upload className="size-4" aria-hidden />}>
            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <label
                  className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-300 bg-white px-4 py-6 text-center transition hover:border-teal-500 hover:bg-teal-50"
                  htmlFor="csv-upload"
                >
                  <Upload className="size-6 text-teal-700" aria-hidden />
                  <span className="text-sm font-medium text-zinc-950">
                    {fileName || "Choose a ShipHero lot CSV"}
                  </span>
                  <span className="text-xs text-zinc-600">
                    Required columns: name, sku. Optional: expires_at, is_active, customer_account_id.
                  </span>
                </label>
                <input
                  ref={fileInputRef}
                  id="csv-upload"
                  className="sr-only"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileChange}
                />
              </div>
              <div className="flex flex-row gap-2 md:flex-col">
                <button className="btn-secondary w-full md:w-36" type="button" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="size-4" aria-hidden />
                  Upload
                </button>
                <button className="btn-ghost w-full md:w-36" type="button" onClick={clearFile} disabled={!rows.length}>
                  <CircleStop className="size-4" aria-hidden />
                  Reset
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <label className="field-label" htmlFor="csv-paste">
                Paste CSV
              </label>
              <textarea
                id="csv-paste"
                className="min-h-28 w-full resize-y rounded-md border border-zinc-300 bg-white p-3 font-mono text-sm outline-none ring-teal-600 transition focus:ring-2"
                placeholder="name,sku,expires_at,is_active,customer_account_id,notes"
                value={csvText}
                onChange={(event) => setCsvText(event.target.value)}
                spellCheck={false}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={loadPastedCsv}
                  disabled={!csvText.trim()}
                >
                  <FileCheck2 className="size-4" aria-hidden />
                  Load pasted CSV
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-zinc-800">{statusText}</span>
                <StatusBadge state={state} />
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200">
                <div
                  className="h-full rounded-full bg-teal-600 transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-zinc-600">
                {processed} of {rows.length} rows processed
              </div>
              {lastTraceId ? (
                <div className="mt-2 break-all font-mono text-xs text-zinc-500">
                  Trace ID: {lastTraceId}
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="Results" icon={<CheckCircle2 className="size-4" aria-hidden />}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-zinc-600">
                {results.length ? `${results.length} result rows` : "No results yet."}
              </div>
              <button
                className="btn-secondary"
                type="button"
                onClick={downloadResults}
                disabled={!results.length}
              >
                <Download className="size-4" aria-hidden />
                Results CSV
              </button>
            </div>
            <div className="w-full max-w-full overflow-x-auto rounded-md border border-zinc-200 bg-white">
              <table className="min-w-[900px] w-full text-left text-sm">
                <thead className="bg-zinc-100 text-xs uppercase text-zinc-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Row</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Lot</th>
                    <th className="px-3 py-2 font-semibold">SKU</th>
                    <th className="px-3 py-2 font-semibold">Expires</th>
                    <th className="px-3 py-2 font-semibold">Lot ID</th>
                    <th className="px-3 py-2 font-semibold">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length ? (
                    results.map((result, index) => (
                      <tr className="border-t border-zinc-200" key={`${result.rowNumber}-${index}`}>
                        <td className="px-3 py-2 text-zinc-700">{result.rowNumber}</td>
                        <td className="px-3 py-2">
                          <ResultBadge status={result.status} />
                        </td>
                        <td className="px-3 py-2 font-medium text-zinc-950">{result.lotName}</td>
                        <td className="px-3 py-2 text-zinc-700">{result.sku}</td>
                        <td className="px-3 py-2 text-zinc-700">{result.expiresAt}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-700">{result.lotId}</td>
                        <td className="max-w-md px-3 py-2 text-zinc-700">{result.message}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-3 py-8 text-center text-sm text-zinc-500" colSpan={7}>
                        Upload a CSV and run the dry check.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </section>
    </main>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-950">
        <span className="flex size-7 items-center justify-center rounded-md bg-teal-50 text-teal-700">
          {icon}
        </span>
        {title}
      </div>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "good" | "bad" | "warn";
}) {
  const toneClass = {
    neutral: "border-zinc-200 bg-white text-zinc-950",
    good: "border-teal-200 bg-teal-50 text-teal-950",
    bad: "border-rose-200 bg-rose-50 text-rose-950",
    warn: "border-amber-200 bg-amber-50 text-amber-950",
  }[tone];

  return (
    <div className={`rounded-md border px-4 py-3 ${toneClass}`}>
      <div className="text-xs font-medium uppercase text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-900">
      <span>{label}</span>
      <input
        className="size-4 accent-teal-700"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function AccountLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[86px_1fr] gap-2">
      <dt className="text-teal-800">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-xs text-teal-950">{value}</dd>
    </div>
  );
}

function StatusBadge({ state }: { state: RunState }) {
  const settings = {
    idle: { label: "Ready", className: "bg-zinc-200 text-zinc-700", icon: CheckCircle2 },
    checking: { label: "Checking", className: "bg-amber-100 text-amber-800", icon: Loader2 },
    running: { label: "Running", className: "bg-amber-100 text-amber-800", icon: Loader2 },
    done: { label: "Done", className: "bg-teal-100 text-teal-800", icon: CheckCircle2 },
    error: { label: "Needs attention", className: "bg-rose-100 text-rose-800", icon: XCircle },
  }[state];
  const Icon = settings.icon;

  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold ${settings.className}`}>
      <Icon className={`size-3.5 ${state === "checking" || state === "running" ? "animate-spin" : ""}`} aria-hidden />
      {settings.label}
    </span>
  );
}

function ResultBadge({ status }: { status: LotResult["status"] }) {
  const settings = {
    DRY_RUN: "bg-zinc-100 text-zinc-700",
    CREATED: "bg-teal-100 text-teal-800",
    SKIPPED: "bg-amber-100 text-amber-800",
    ERROR: "bg-rose-100 text-rose-800",
    THROTTLED: "bg-amber-100 text-amber-800",
  }[status];

  return (
    <span className={`inline-flex h-7 items-center rounded-md px-2 text-xs font-semibold ${settings}`}>
                  {status}
    </span>
  );
}

function buildSkippedResults(
  rows: LotInputRow[],
  createdLotKeys: Set<string>,
  accountId?: string,
): LotResult[] {
  return rows
    .filter((row) => createdLotKeys.has(lotRowKey(row, accountId)))
    .map((row) => {
      try {
        const payload = normalizeLotRow(row);
        return {
          rowNumber: row.rowNumber,
          status: "SKIPPED",
          lotName: payload.name,
          sku: payload.sku,
          expiresAt: payload.expires_at ?? "",
          message: "Already created in this browser session.",
        };
      } catch {
        return {
          rowNumber: row.rowNumber,
          status: "SKIPPED",
          message: "Already created in this browser session.",
        };
      }
    });
}

function rememberCreatedLots(
  results: LotResult[],
  rows: LotInputRow[],
  accountId: string | undefined,
  setCreatedLotKeys: (updater: (previous: Set<string>) => Set<string>) => void,
) {
  const createdRows = new Set(
    results
      .filter((result) => result.status === "CREATED")
      .map((result) => result.rowNumber)
      .filter((rowNumber): rowNumber is number => typeof rowNumber === "number"),
  );

  if (!createdRows.size) {
    return;
  }

  setCreatedLotKeys((previous) => {
    const next = new Set(previous);
    rows
      .filter((row) => createdRows.has(row.rowNumber))
      .forEach((row) => next.add(lotRowKey(row, accountId)));
    return next;
  });
}

function lotRowKey(row: LotInputRow, accountId?: string): string {
  try {
    const payload = normalizeLotRow(row);
    return [
      accountId || "unverified",
      payload.name,
      payload.sku,
      payload.expires_at ?? "",
      payload.customer_account_id ?? "",
    ]
      .map((value) => value.trim().toLowerCase())
      .join("|");
  } catch {
    return `${accountId || "unverified"}|row:${row.rowNumber}`;
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out. ShipHero did not respond in time.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function downloadText(fileName: string, contents: string) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function formatApiError(message: string, traceId?: string): string {
  return traceId ? `${message} | Trace ID: ${traceId}` : message;
}
