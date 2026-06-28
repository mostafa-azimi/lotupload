"use client";

import {
  AlertTriangle,
  Barcode,
  CheckCircle2,
  CircleStop,
  Download,
  FileCheck2,
  KeyRound,
  ListChecks,
  Loader2,
  MapPin,
  Moon,
  PackagePlus,
  Play,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import {
  BULK_OPERATIONS,
  countResults,
  getOperationConfig,
  parseBulkCsv,
  resultsToCsv,
  templateCsvForOperation,
  type BulkInputRow,
  type BulkOperationId,
  type BulkResult,
  type BulkStatus,
} from "@/lib/bulk";

type VerifiedAccount = {
  email: string;
  userId: string;
  accountId: string;
  requestId: string;
};

type RunState = "idle" | "checking" | "running" | "done" | "error";
type ThemeMode = "light" | "dark";

const BATCH_SIZE = 20;

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [operationId, setOperationId] = useState<BulkOperationId>("lots");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [clientId, setClientId] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [account, setAccount] = useState<VerifiedAccount | null>(null);
  const [rows, setRows] = useState<BulkInputRow[]>([]);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [stopOnError, setStopOnError] = useState(true);
  const [skipExisting, setSkipExisting] = useState(true);
  const [throttleMs, setThrottleMs] = useState(150);
  const [state, setState] = useState<RunState>("idle");
  const [statusText, setStatusText] = useState("Choose a tool and load a CSV.");
  const [lastTraceId, setLastTraceId] = useState("");
  const [results, setResults] = useState<BulkResult[]>([]);
  const [processed, setProcessed] = useState(0);
  const [runLog, setRunLog] = useState<string[]>([]);

  const operation = getOperationConfig(operationId);
  const counts = useMemo(() => countResults(results), [results]);
  const canRun = rows.length > 0 && state !== "checking" && state !== "running";
  const authReady = Boolean(clientId.trim() && refreshToken.trim());
  const liveRunBlocked = !dryRun && !account;
  const progressPercent = rows.length ? Math.round((processed / rows.length) * 100) : 0;
  const changedCount = dryRun ? counts.validated : counts.created + counts.updated;

  function changeTheme(nextTheme: ThemeMode) {
    setTheme(nextTheme);
  }

  function changeOperation(nextOperationId: BulkOperationId) {
    setOperationId(nextOperationId);
    setRows([]);
    setCsvText("");
    setFileName("");
    setResults([]);
    setProcessed(0);
    setLastTraceId("");
    setState("idle");
    setStatusText(`${getOperationConfig(nextOperationId).title} selected.`);
    addLog(`Switched to ${getOperationConfig(nextOperationId).title}.`);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function updateClientId(value: string) {
    setClientId(value);
    setAccount(null);
    setState("idle");
    setStatusText("Client ID changed. Reconnect before live mode.");
  }

  function updateRefreshToken(value: string) {
    setRefreshToken(value);
    setAccount(null);
    setState("idle");
    setStatusText(value.trim() ? "Refresh token entered. Connect to verify account." : "Enter login details.");
  }

  async function connectAccount() {
    if (!clientId.trim()) {
      setState("error");
      setStatusText("Enter the ShipHero OAuth client ID for this refresh token.");
      return;
    }
    if (!refreshToken.trim()) {
      setState("error");
      setStatusText("Paste a ShipHero refresh token first.");
      return;
    }

    setState("checking");
    setAccount(null);
    setStatusText("Connecting to ShipHero...");
    addLog("Checking refresh token with ShipHero.");

    try {
      const response = await fetchWithTimeout("/api/shiphero/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken, clientId }),
      });
      const body = await response.json();
      setLastTraceId(body.traceId ?? "");

      if (!response.ok || !body.ok) {
        throw new Error(formatApiError(body.error || "Login failed.", body.traceId));
      }

      if (body.rotatedRefreshToken) {
        setRefreshToken(body.rotatedRefreshToken);
        addLog("ShipHero rotated the refresh token. The current browser session was updated.");
      }

      setAccount(body.account);
      setState("idle");
      setStatusText("Connected. Confirm the account before running live mode.");
      addLog(`Connected as ${body.account?.email || "ShipHero user"}.`);
    } catch (error) {
      setState("error");
      setStatusText(readError(error));
      addLog(`Login failed: ${readError(error)}`);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      loadCsvText(text, file.name);
    } catch (error) {
      setRows([]);
      setState("error");
      setStatusText(readError(error));
      addLog(`CSV load failed: ${readError(error)}`);
    }
  }

  function loadPastedCsv() {
    loadCsvText(csvText, "Pasted CSV");
  }

  function loadCsvText(text: string, sourceName: string) {
    try {
      const parsedRows = parseBulkCsv(text, operationId);
      setRows(parsedRows);
      setFileName(sourceName);
      setResults([]);
      setProcessed(0);
      setState("idle");
      setStatusText(`Loaded ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"}.`);
      addLog(`Loaded ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"} for ${operation.title}.`);
    } catch (error) {
      setRows([]);
      setState("error");
      setStatusText(readError(error));
      addLog(`CSV validation failed: ${readError(error)}`);
    }
  }

  async function runBulkUpdate() {
    if (!canRun) return;
    if (liveRunBlocked) {
      setState("error");
      setStatusText("Connect the refresh token account before running live mode.");
      return;
    }

    setState("running");
    setResults([]);
    setProcessed(0);
    setStatusText(dryRun ? "Checking CSV rows..." : `Running ${operation.title}...`);
    addLog(dryRun ? "Dry run started." : `Live run started for ${operation.title}.`);

    const nextResults: BulkResult[] = [];
    let activeRefreshToken = refreshToken;

    try {
      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        addLog(`Sending rows ${batch[0]?.rowNumber ?? ""}-${batch[batch.length - 1]?.rowNumber ?? ""}.`);

        const response = await fetchWithTimeout("/api/shiphero/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId,
            refreshToken: activeRefreshToken,
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
          throw new Error(formatApiError(body.error || "Bulk update failed.", body.traceId));
        }

        if (body.rotatedRefreshToken) {
          activeRefreshToken = body.rotatedRefreshToken;
          setRefreshToken(body.rotatedRefreshToken);
          addLog("ShipHero rotated the refresh token during the run.");
        }

        nextResults.push(...body.results);
        setResults([...nextResults]);
        setProcessed(Math.min(start + batch.length, rows.length));
        addLog(`Batch finished. Trace ${body.traceId}.`);

        if (body.halted) {
          setState("error");
          setStatusText("Stopped because a row needs attention.");
          addLog("Run stopped on an error. Download results and follow the next_step column.");
          return;
        }
      }

      setState("done");
      setStatusText(dryRun ? "Dry run finished. No ShipHero records were changed." : "Live run finished.");
      addLog(dryRun ? "Dry run finished." : "Live run finished.");
    } catch (error) {
      setState("error");
      setStatusText(readError(error));
      addLog(`Run failed: ${readError(error)}`);
    }
  }

  function clearFile() {
    setRows([]);
    setResults([]);
    setProcessed(0);
    setFileName("");
    setStatusText("CSV cleared.");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function clearLogin() {
    setRefreshToken("");
    setClientId("");
    setAccount(null);
    setState("idle");
    setStatusText("Login cleared.");
    addLog("Login cleared from this browser session.");
  }

  function downloadTemplate() {
    downloadText(operation.templateFileName, templateCsvForOperation(operationId));
  }

  function downloadResults() {
    downloadText(operation.resultsFileName, resultsToCsv(results));
  }

  function addLog(message: string) {
    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setRunLog((previous) => [`${timestamp} ${message}`, ...previous].slice(0, 80));
  }

  return (
    <main
      className={`${theme === "dark" ? "dark " : ""}min-h-screen bg-stone-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50`}
    >
      <section className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-teal-700 dark:text-teal-300">
                ShipHero bulk updater
              </p>
              <h1 className="mt-1 text-2xl font-semibold text-zinc-950 sm:text-3xl dark:text-zinc-50">
                {operation.title}
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
                {operation.summary}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => changeTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? (
                  <Sun className="size-4" aria-hidden />
                ) : (
                  <Moon className="size-4" aria-hidden />
                )}
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              <button className="btn-secondary" type="button" onClick={downloadTemplate}>
                <Download className="size-4" aria-hidden />
                Template CSV
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={runBulkUpdate}
                disabled={!canRun || liveRunBlocked}
                title={liveRunBlocked ? "Connect the account before live mode." : "Run bulk update"}
              >
                {state === "running" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-4" aria-hidden />
                )}
                {dryRun ? operation.dryRunLabel : operation.liveRunLabel}
              </button>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-5">
            {BULK_OPERATIONS.map((item) => (
              <button
                className={`tool-tab ${item.id === operationId ? "tool-tab-active" : ""}`}
                key={item.id}
                type="button"
                onClick={() => changeOperation(item.id)}
              >
                {operationIcon(item.id)}
                <span>{item.navLabel}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-5">
            <Metric label="CSV rows" value={rows.length} tone="neutral" />
            <Metric label={dryRun ? "Validated" : "Changed"} value={changedCount} tone="good" />
            <Metric label="Skipped" value={counts.skipped} tone="warn" />
            <Metric label="Errors" value={counts.errors} tone="bad" />
            <Metric label="Throttled" value={counts.throttled} tone="warn" />
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr] lg:px-8">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Login" icon={<KeyRound className="size-4" aria-hidden />}>
            <label className="field-label" htmlFor="client-id">
              ShipHero OAuth client ID
            </label>
            <input
              id="client-id"
              className="field-input mb-3 font-mono"
              placeholder="Paste matching OAuth client ID"
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
              className="field-textarea min-h-28 font-mono"
              placeholder="Paste refresh token"
              value={refreshToken}
              onChange={(event) => updateRefreshToken(event.target.value)}
              spellCheck={false}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn-secondary"
                type="button"
                onClick={connectAccount}
                disabled={state === "checking" || !authReady}
              >
                {state === "checking" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="size-4" aria-hidden />
                )}
                Connect
              </button>
              <button className="btn-ghost" type="button" onClick={clearLogin} disabled={!authReady && !account}>
                <Trash2 className="size-4" aria-hidden />
                Clear
              </button>
            </div>

            {account ? (
              <div className="mt-4 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-950 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-50">
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
              <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>Live mode stays locked until the refresh token is connected.</span>
              </div>
            )}
          </Panel>

          <Panel title="Run Settings" icon={<FileCheck2 className="size-4" aria-hidden />}>
            <div className="space-y-3">
              <Toggle checked={dryRun} label="Dry run" onChange={setDryRun} />
              <Toggle checked={stopOnError} label="Stop on first error" onChange={setStopOnError} />
              {operation.supportsSkipExisting ? (
                <Toggle checked={skipExisting} label="Skip existing / no-op rows" onChange={setSkipExisting} />
              ) : null}
              <label className="field-label" htmlFor="throttle">
                Delay between live requests
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="throttle"
                  className="field-input w-28"
                  min={0}
                  max={2000}
                  step={50}
                  type="number"
                  value={throttleMs}
                  onChange={(event) => setThrottleMs(Number(event.target.value))}
                />
                <span className="text-sm text-zinc-600 dark:text-zinc-400">ms</span>
              </div>
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="CSV" icon={<Upload className="size-4" aria-hidden />}>
            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
              <label
                className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-300 bg-white px-4 py-6 text-center transition hover:border-teal-500 hover:bg-teal-50 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-teal-500 dark:hover:bg-teal-950/30"
                htmlFor="csv-upload"
              >
                <Upload className="size-6 text-teal-700 dark:text-teal-300" aria-hidden />
                <span className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
                  {fileName || `Choose ${operation.navLabel} CSV`}
                </span>
                <span className="max-w-xl text-xs text-zinc-600 dark:text-zinc-400">
                  Required: {operation.requiredColumns.join(", ")}. Optional:{" "}
                  {operation.optionalColumns.join(", ") || "none"}.
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

            <div className="mt-4">
              <label className="field-label" htmlFor="csv-paste">
                Paste CSV
              </label>
              <textarea
                id="csv-paste"
                className="field-textarea min-h-28 font-mono"
                placeholder={templateCsvForOperation(operationId)}
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
          </Panel>

          <Panel title="Status And Log" icon={<ListChecks className="size-4" aria-hidden />}>
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-medium text-zinc-800 dark:text-zinc-100">{statusText}</span>
              <StatusBadge state={state} />
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-teal-600 transition-all dark:bg-teal-400"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              {processed} of {rows.length} rows processed
            </div>
            {lastTraceId ? (
              <div className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">
                Trace ID: {lastTraceId}
              </div>
            ) : null}
            <div className="mt-4 max-h-40 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              {runLog.length ? (
                runLog.map((entry, index) => <div key={`${entry}-${index}`}>{entry}</div>)
              ) : (
                <div>No log entries yet.</div>
              )}
            </div>
          </Panel>

          <Panel title="Results" icon={<CheckCircle2 className="size-4" aria-hidden />}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
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
            {counts.errors || counts.throttled ? (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                Download results, filter to ERROR or THROTTLED, follow the next_step column, then rerun only those rows.
              </div>
            ) : null}
            <div className="w-full max-w-full overflow-x-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="bg-zinc-100 text-xs uppercase text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Row</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Identifier</th>
                    <th className="px-3 py-2 font-semibold">SKU</th>
                    <th className="px-3 py-2 font-semibold">Location</th>
                    <th className="px-3 py-2 font-semibold">Requested</th>
                    <th className="px-3 py-2 font-semibold">Request ID</th>
                    <th className="px-3 py-2 font-semibold">Message</th>
                    <th className="px-3 py-2 font-semibold">Next Step</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length ? (
                    results.map((result, index) => (
                      <tr className="border-t border-zinc-200 dark:border-zinc-800" key={`${result.rowNumber}-${index}`}>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{result.rowNumber}</td>
                        <td className="px-3 py-2">
                          <ResultBadge status={result.status} />
                        </td>
                        <td className="px-3 py-2 font-medium text-zinc-950 dark:text-zinc-50">
                          {result.identifier}
                        </td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{result.sku}</td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.locationName || result.locationId}
                        </td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{result.requestedValue}</td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                          {result.requestId}
                        </td>
                        <td className="max-w-md px-3 py-2 text-zinc-700 dark:text-zinc-300">{result.message}</td>
                        <td className="max-w-md px-3 py-2 text-zinc-700 dark:text-zinc-300">{result.nextStep}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-3 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400" colSpan={9}>
                        Load a CSV and run the dry check.
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

function operationIcon(operationId: BulkOperationId) {
  const className = "size-4 shrink-0";
  if (operationId === "lots") return <PackagePlus className={className} aria-hidden />;
  if (operationId === "product-case-barcodes") return <Barcode className={className} aria-hidden />;
  return <MapPin className={className} aria-hidden />;
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
    <section className="min-w-0 rounded-md border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
        <span className="flex size-7 items-center justify-center rounded-md bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
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
    neutral:
      "border-zinc-200 bg-white text-zinc-950 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50",
    good:
      "border-teal-200 bg-teal-50 text-teal-950 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-50",
    bad:
      "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-50",
    warn:
      "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-50",
  }[tone];

  return (
    <div className={`rounded-md border px-4 py-3 ${toneClass}`}>
      <div className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">{label}</div>
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
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
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
      <dt className="text-teal-800 dark:text-teal-200">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-xs text-teal-950 dark:text-teal-50">{value}</dd>
    </div>
  );
}

function StatusBadge({ state }: { state: RunState }) {
  const settings = {
    idle: { label: "Ready", className: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200", icon: CheckCircle2 },
    checking: { label: "Checking", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100", icon: Loader2 },
    running: { label: "Running", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100", icon: Loader2 },
    done: { label: "Done", className: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-100", icon: CheckCircle2 },
    error: { label: "Needs attention", className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100", icon: XCircle },
  }[state];
  const Icon = settings.icon;

  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold ${settings.className}`}>
      <Icon className={`size-3.5 ${state === "checking" || state === "running" ? "animate-spin" : ""}`} aria-hidden />
      {settings.label}
    </span>
  );
}

function ResultBadge({ status }: { status: BulkStatus }) {
  const settings = {
    DRY_RUN: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
    CREATED: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-100",
    UPDATED: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-100",
    SKIPPED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100",
    ERROR: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100",
    THROTTLED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100",
  }[status];

  return (
    <span className={`inline-flex h-7 items-center rounded-md px-2 text-xs font-semibold ${settings}`}>
      {status}
    </span>
  );
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

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
