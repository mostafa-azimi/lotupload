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
  Save,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  UsersRound,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import {
  BULK_OPERATIONS,
  countResults,
  getOperationConfig,
  parseBulkCsv,
  resultsToCsv,
  type BulkInputRow,
  type BulkOperationId,
  type BulkResult,
  type BulkStatus,
} from "@/lib/bulk";

type VerifiedAccount = {
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

type ShipHeroCustomerAccount = {
  id: string;
  legacyId?: string | number;
  email?: string;
  username?: string;
  displayName: string;
};

type SavedConnection = {
  id: string;
  label: string;
  mode: "brand" | "3pl";
  clientId: string;
  refreshToken: string;
  parentAccountId?: string;
  parentEmail?: string;
  parentUsername?: string;
  childAccountId?: string;
  childAccountName?: string;
  updatedAt: string;
};

type RunState = "idle" | "checking" | "running" | "done" | "error";
type ThemeMode = "light" | "dark";

const BATCH_SIZE = 20;
const CONNECTIONS_STORAGE_KEY = "shiphero-bulk-connections-v1";

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [operationId, setOperationId] = useState<BulkOperationId>("lots");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [clientId, setClientId] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [account, setAccount] = useState<VerifiedAccount | null>(null);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>(
    [],
  );
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [profileLabel, setProfileLabel] = useState("");
  const [childAccountId, setChildAccountId] = useState("");
  const [childAccountName, setChildAccountName] = useState("");
  const [showConnectionScreen, setShowConnectionScreen] = useState(true);
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

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSavedConnections(readSavedConnections());
      setConnectionsLoaded(true);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!connectionsLoaded) return;
    window.localStorage.setItem(
      CONNECTIONS_STORAGE_KEY,
      JSON.stringify(savedConnections),
    );
  }, [connectionsLoaded, savedConnections]);

  const operation = getOperationConfig(operationId);
  const counts = useMemo(() => countResults(results), [results]);
  const operationUsesChildAccount =
    operationId === "lots" || operationId === "product-case-barcodes";
  const selectedChildAccount = useMemo(
    () =>
      account?.customers.find(
        (customer) => customer.id === childAccountId.trim(),
      ) ?? null,
    [account, childAccountId],
  );
  const canRun = rows.length > 0 && state !== "checking" && state !== "running";
  const authReady = Boolean(clientId.trim() && refreshToken.trim());
  const needsChildAccount = Boolean(
    account?.is3pl && operationUsesChildAccount,
  );
  const selectedCustomerAccountId = needsChildAccount
    ? childAccountId.trim() || selectedChildAccount?.id || ""
    : "";
  const liveRunBlocked =
    !dryRun && (!account || (needsChildAccount && !selectedCustomerAccountId));
  const progressPercent = rows.length
    ? Math.round((processed / rows.length) * 100)
    : 0;
  const changedCount = dryRun
    ? counts.validated
    : counts.created + counts.updated;
  const activeScopeText = account
    ? account.is3pl
      ? operationUsesChildAccount
        ? selectedCustomerAccountId
          ? `3PL child account: ${childAccountName || selectedChildAccount?.displayName || selectedCustomerAccountId}`
          : "3PL child account required for this tool"
        : "3PL parent account: location updates stay at the 3PL/location level"
      : `Brand account: ${account.email || account.username || account.accountId || "connected"}`
    : "No connected account";

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
    setSelectedConnectionId("");
    setAccount(null);
    setState("idle");
    setStatusText("Client ID changed. Reconnect before live mode.");
  }

  function updateRefreshToken(value: string) {
    setRefreshToken(value);
    setSelectedConnectionId("");
    setAccount(null);
    setState("idle");
    setStatusText(
      value.trim()
        ? "Refresh token entered. Connect to verify account."
        : "Enter login details.",
    );
  }

  function chooseChildAccount(nextChildAccountId: string) {
    const child = account?.customers.find(
      (customer) => customer.id === nextChildAccountId,
    );
    setChildAccountId(nextChildAccountId);
    if (child) {
      setChildAccountName(child.displayName);
      if (!profileLabel.trim()) {
        setProfileLabel(child.displayName);
      }
    }
  }

  function selectSavedConnection(connectionId: string) {
    setSelectedConnectionId(connectionId);
    const connection = savedConnections.find(
      (saved) => saved.id === connectionId,
    );
    if (!connection) {
      setAccount(null);
      setProfileLabel("");
      setChildAccountId("");
      setChildAccountName("");
      return;
    }

    setClientId(connection.clientId);
    setRefreshToken(connection.refreshToken);
    setProfileLabel(connection.label);
    setChildAccountId(connection.childAccountId ?? "");
    setChildAccountName(connection.childAccountName ?? "");
    setAccount(savedConnectionToAccount(connection));
    setState("idle");
    setStatusText(`Loaded saved connection: ${connection.label}.`);
    addLog(`Loaded saved connection ${connection.label}.`);
  }

  function saveCurrentConnection(
    options: {
      accountOverride?: VerifiedAccount | null;
      refreshTokenOverride?: string;
      silent?: boolean;
    } = {},
  ) {
    const currentAccount = options.accountOverride ?? account;
    const currentRefreshToken = options.refreshTokenOverride ?? refreshToken;

    if (!currentAccount) {
      if (!options.silent) {
        setState("error");
        setStatusText("Connect the refresh token before saving a profile.");
      }
      return false;
    }
    if (!clientId.trim() || !currentRefreshToken.trim()) {
      if (!options.silent) {
        setState("error");
        setStatusText(
          "Client ID and refresh token are required before saving.",
        );
      }
      return false;
    }

    const selectedChild =
      currentAccount.customers.find(
        (customer) => customer.id === childAccountId.trim(),
      ) ?? null;
    const is3pl = currentAccount.is3pl;
    const childId = is3pl ? childAccountId.trim() : "";
    const childName = is3pl
      ? childAccountName.trim() || selectedChild?.displayName || childId
      : "";

    if (is3pl && !childId) {
      if (!options.silent) {
        setState("error");
        setStatusText(
          "Choose or enter the 3PL child account before saving this profile.",
        );
      }
      return false;
    }

    const label =
      profileLabel.trim() ||
      (is3pl
        ? childName
        : currentAccount.email ||
          currentAccount.username ||
          currentAccount.accountId ||
          "ShipHero brand");
    const connectionId = selectedConnectionId || createConnectionId();
    const connection: SavedConnection = {
      id: connectionId,
      label,
      mode: is3pl ? "3pl" : "brand",
      clientId: clientId.trim(),
      refreshToken: currentRefreshToken.trim(),
      parentAccountId: currentAccount.accountId,
      parentEmail: currentAccount.email,
      parentUsername: currentAccount.username,
      childAccountId: childId || undefined,
      childAccountName: childName || undefined,
      updatedAt: new Date().toISOString(),
    };

    setSavedConnections((previous) => [
      connection,
      ...previous.filter((saved) => saved.id !== connectionId),
    ]);
    setSelectedConnectionId(connectionId);
    setProfileLabel(label);
    if (childName) {
      setChildAccountName(childName);
    }

    if (!options.silent) {
      setState("idle");
      setStatusText(`Saved connection: ${label}.`);
      addLog(`Saved connection ${label}.`);
    }
    return true;
  }

  function forgetSavedConnection() {
    if (!selectedConnectionId) return;
    const connection = savedConnections.find(
      (saved) => saved.id === selectedConnectionId,
    );
    setSavedConnections((previous) =>
      previous.filter((saved) => saved.id !== selectedConnectionId),
    );
    setSelectedConnectionId("");
    setStatusText(
      connection
        ? `Forgot saved connection: ${connection.label}.`
        : "Saved connection removed.",
    );
    addLog(
      connection
        ? `Forgot saved connection ${connection.label}.`
        : "Saved connection removed.",
    );
  }

  function persistRotatedRefreshToken(nextRefreshToken: string) {
    if (!nextRefreshToken.trim() || !selectedConnectionId) return;
    setSavedConnections((previous) =>
      previous.map((connection) =>
        connection.id === selectedConnectionId
          ? {
              ...connection,
              refreshToken: nextRefreshToken.trim(),
              updatedAt: new Date().toISOString(),
            }
          : connection,
      ),
    );
  }

  function continueToTools() {
    setShowConnectionScreen(false);
    setState("idle");
    setStatusText(
      account
        ? `${operation.title} selected.`
        : "Viewing tools without a connected account. Live mode requires connection.",
    );
    addLog(
      account
        ? `Using account scope: ${activeScopeText}.`
        : "Viewing tools without account connection.",
    );
  }

  function switchConnection() {
    setShowConnectionScreen(true);
    setState("idle");
    setStatusText("Choose or connect a ShipHero account.");
  }

  async function connectAccount() {
    if (!clientId.trim()) {
      setState("error");
      setStatusText(
        "Enter the ShipHero OAuth client ID for this refresh token.",
      );
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
        throw new Error(
          formatApiError(body.error || "Login failed.", body.traceId),
        );
      }

      if (body.rotatedRefreshToken) {
        setRefreshToken(body.rotatedRefreshToken);
        persistRotatedRefreshToken(body.rotatedRefreshToken);
        addLog(
          "ShipHero rotated the refresh token. The current browser session was updated.",
        );
      }

      const connectedAccount = normalizeVerifiedAccount(body.account);
      const nextRefreshToken = body.rotatedRefreshToken || refreshToken;
      setAccount(connectedAccount);
      if (!connectedAccount.is3pl) {
        setChildAccountId("");
        setChildAccountName("");
        saveCurrentConnection({
          accountOverride: connectedAccount,
          refreshTokenOverride: nextRefreshToken,
          silent: true,
        });
      } else if (childAccountId.trim()) {
        const connectedChild = connectedAccount.customers.find(
          (customer) => customer.id === childAccountId.trim(),
        );
        if (connectedChild && !childAccountName.trim()) {
          setChildAccountName(connectedChild.displayName);
        }
        saveCurrentConnection({
          accountOverride: connectedAccount,
          refreshTokenOverride: nextRefreshToken,
          silent: true,
        });
      }
      setState("idle");
      setStatusText(
        connectedAccount.is3pl
          ? "Connected 3PL account. Choose a child account for SKU tools; location tools stay on the 3PL account."
          : "Connected brand account. Profile saved in this browser.",
      );
      addLog(
        `Connected as ${connectedAccount.email || connectedAccount.username || "ShipHero user"}.`,
      );
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
      setStatusText(
        `Loaded ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"}.`,
      );
      addLog(
        `Loaded ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"} for ${operation.title}.`,
      );
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
      setStatusText(
        account && needsChildAccount
          ? "Choose a 3PL child account before running this SKU-based tool live."
          : "Connect the refresh token account before running live mode.",
      );
      return;
    }

    setState("running");
    setResults([]);
    setProcessed(0);
    setStatusText(
      dryRun ? "Checking CSV rows..." : `Running ${operation.title}...`,
    );
    addLog(
      dryRun ? "Dry run started." : `Live run started for ${operation.title}.`,
    );

    const nextResults: BulkResult[] = [];
    let activeRefreshToken = refreshToken;

    try {
      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        addLog(
          `Sending rows ${batch[0]?.rowNumber ?? ""}-${batch[batch.length - 1]?.rowNumber ?? ""}.`,
        );

        const response = await fetchWithTimeout("/api/shiphero/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId,
            refreshToken: activeRefreshToken,
            clientId,
            selectedCustomerAccountId,
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
          throw new Error(
            formatApiError(body.error || "Bulk update failed.", body.traceId),
          );
        }

        if (body.rotatedRefreshToken) {
          activeRefreshToken = body.rotatedRefreshToken;
          setRefreshToken(body.rotatedRefreshToken);
          persistRotatedRefreshToken(body.rotatedRefreshToken);
          addLog("ShipHero rotated the refresh token during the run.");
        }

        nextResults.push(...body.results);
        setResults([...nextResults]);
        setProcessed(Math.min(start + batch.length, rows.length));
        addLog(`Batch finished. Trace ${body.traceId}.`);

        if (body.halted) {
          setState("error");
          setStatusText("Stopped because a row needs attention.");
          addLog(
            "Run stopped on an error. Download results and follow the next_step column.",
          );
          return;
        }
      }

      setState("done");
      setStatusText(
        dryRun
          ? "Dry run finished. No ShipHero records were changed."
          : "Live run finished.",
      );
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
    setSelectedConnectionId("");
    setProfileLabel("");
    setChildAccountId("");
    setChildAccountName("");
    setShowConnectionScreen(true);
    setState("idle");
    setStatusText("Login cleared.");
    addLog("Login cleared from this browser session.");
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
    setRunLog((previous) =>
      [`${timestamp} ${message}`, ...previous].slice(0, 80),
    );
  }

  const connectionPanel = (
    <Panel
      title="Connection"
      icon={<KeyRound className="size-4" aria-hidden />}
    >
      <label className="field-label" htmlFor="saved-connection">
        Saved connection
      </label>
      <select
        id="saved-connection"
        className="field-input mb-3"
        value={selectedConnectionId}
        onChange={(event) => selectSavedConnection(event.target.value)}
      >
        <option value="">New connection</option>
        {savedConnections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.label}{" "}
            {connection.mode === "3pl" ? "(3PL child)" : "(Brand)"}
          </option>
        ))}
      </select>

      <label className="field-label" htmlFor="profile-label">
        Profile name
      </label>
      <input
        id="profile-label"
        className="field-input mb-3"
        placeholder="Example: Acme child account"
        value={profileLabel}
        onChange={(event) => setProfileLabel(event.target.value)}
        autoComplete="off"
      />

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

      {account?.is3pl ? (
        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            <UsersRound
              className="size-4 text-teal-700 dark:text-teal-300"
              aria-hidden
            />
            3PL child account
          </div>
          {account.customers.length ? (
            <>
              <label className="field-label" htmlFor="child-account-select">
                ShipHero child account
              </label>
              <select
                id="child-account-select"
                className="field-input mb-3"
                value={childAccountId}
                onChange={(event) => chooseChildAccount(event.target.value)}
              >
                <option value="">Choose child account</option>
                {account.customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              ShipHero did not return child accounts. Enter the child account ID
              manually.
            </div>
          )}
          <label className="field-label" htmlFor="child-account-name">
            Child account name
          </label>
          <input
            id="child-account-name"
            className="field-input mb-3"
            placeholder="Friendly name for the dropdown"
            value={childAccountName}
            onChange={(event) => setChildAccountName(event.target.value)}
            autoComplete="off"
          />
          <label className="field-label" htmlFor="child-account-id">
            Child account ID
          </label>
          <input
            id="child-account-id"
            className="field-input font-mono"
            placeholder="Required for lots and case barcode updates"
            value={childAccountId}
            onChange={(event) => setChildAccountId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {account.customerPageLimitReached ? (
            <div className="mt-2 text-xs text-amber-700 dark:text-amber-200">
              Customer list was capped. Use the manual child account ID field if
              the account is missing.
            </div>
          ) : null}
        </div>
      ) : null}

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
        <button
          className="btn-secondary"
          type="button"
          onClick={() => saveCurrentConnection()}
          disabled={!account || (account.is3pl && !childAccountId.trim())}
        >
          <Save className="size-4" aria-hidden />
          Save profile
        </button>
        <button
          className="btn-ghost"
          type="button"
          onClick={clearLogin}
          disabled={!authReady && !account}
        >
          <Trash2 className="size-4" aria-hidden />
          Clear
        </button>
        <button
          className="btn-ghost"
          type="button"
          onClick={forgetSavedConnection}
          disabled={!selectedConnectionId}
        >
          <Trash2 className="size-4" aria-hidden />
          Forget
        </button>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
        <UsersRound
          className="mt-0.5 size-4 shrink-0 text-teal-700 dark:text-teal-300"
          aria-hidden
        />
        <span>{activeScopeText}</span>
      </div>

      {account ? (
        <div className="mt-4 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-950 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-50">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="size-4" aria-hidden />
            Connected account
          </div>
          <dl className="mt-3 grid gap-2">
            <AccountLine label="Mode" value={account.is3pl ? "3PL" : "Brand"} />
            <AccountLine
              label="Email"
              value={account.email || "Not returned"}
            />
            <AccountLine
              label="Username"
              value={account.username || "Not returned"}
            />
            <AccountLine
              label="User ID"
              value={account.userId || "Not returned"}
            />
            <AccountLine
              label="Account ID"
              value={account.accountId || "Not returned"}
            />
            <AccountLine
              label="Customers"
              value={
                account.is3pl
                  ? String(account.customers.length)
                  : "Not a 3PL account"
              }
            />
            <AccountLine
              label="Request ID"
              value={account.requestId || "Not returned"}
            />
          </dl>
        </div>
      ) : (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Live mode stays locked until the refresh token is connected.
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="btn-primary" type="button" onClick={continueToTools}>
          <CheckCircle2 className="size-4" aria-hidden />
          Continue to tools
        </button>
      </div>
    </Panel>
  );

  if (showConnectionScreen) {
    return (
      <main
        className={`${theme === "dark" ? "dark " : ""}min-h-screen bg-stone-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50`}
      >
        <section className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex w-full max-w-4xl items-end justify-between gap-4 px-4 py-5 sm:px-6 lg:px-8">
            <div className="min-w-0">
              <p className="text-sm font-medium text-teal-700 dark:text-teal-300">
                ShipHero bulk updater
              </p>
              <h1 className="mt-1 text-2xl font-semibold text-zinc-950 sm:text-3xl dark:text-zinc-50">
                Connect ShipHero
              </h1>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Link className="btn-secondary" href="/templates">
                <Download className="size-4" aria-hidden />
                Templates
              </Link>
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
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6 lg:px-8">
          {connectionPanel}
        </section>
      </main>
    );
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
              <div className="flex max-w-full items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                <UsersRound
                  className="size-4 shrink-0 text-teal-700 dark:text-teal-300"
                  aria-hidden
                />
                <span className="max-w-72 truncate">{activeScopeText}</span>
              </div>
              <button
                className="btn-secondary"
                type="button"
                onClick={switchConnection}
              >
                <KeyRound className="size-4" aria-hidden />
                Switch account
              </button>
              <Link className="btn-secondary" href="/templates">
                <Download className="size-4" aria-hidden />
                Templates
              </Link>
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
              <button
                className="btn-primary"
                type="button"
                onClick={runBulkUpdate}
                disabled={!canRun || liveRunBlocked}
                title={
                  liveRunBlocked
                    ? needsChildAccount
                      ? "Choose a child account before live mode."
                      : "Connect the account before live mode."
                    : "Run bulk update"
                }
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
            <Metric
              label={dryRun ? "Validated" : "Changed"}
              value={changedCount}
              tone="good"
            />
            <Metric label="Skipped" value={counts.skipped} tone="warn" />
            <Metric label="Errors" value={counts.errors} tone="bad" />
            <Metric label="Throttled" value={counts.throttled} tone="warn" />
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr] lg:px-8">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title="Run Settings"
            icon={<FileCheck2 className="size-4" aria-hidden />}
          >
            <div className="space-y-3">
              <Toggle checked={dryRun} label="Dry run" onChange={setDryRun} />
              <Toggle
                checked={stopOnError}
                label="Stop on first error"
                onChange={setStopOnError}
              />
              {operation.supportsSkipExisting ? (
                <Toggle
                  checked={skipExisting}
                  label="Skip existing / no-op rows"
                  onChange={setSkipExisting}
                />
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
                  onChange={(event) =>
                    setThrottleMs(Number(event.target.value))
                  }
                />
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  ms
                </span>
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
                <Upload
                  className="size-6 text-teal-700 dark:text-teal-300"
                  aria-hidden
                />
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
                <button
                  className="btn-secondary w-full md:w-36"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-4" aria-hidden />
                  Upload
                </button>
                <button
                  className="btn-ghost w-full md:w-36"
                  type="button"
                  onClick={clearFile}
                  disabled={!rows.length}
                >
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
                placeholder="Paste CSV rows here"
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

          <Panel
            title="Status And Log"
            icon={<ListChecks className="size-4" aria-hidden />}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-medium text-zinc-800 dark:text-zinc-100">
                {statusText}
              </span>
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
                runLog.map((entry, index) => (
                  <div key={`${entry}-${index}`}>{entry}</div>
                ))
              ) : (
                <div>No log entries yet.</div>
              )}
            </div>
          </Panel>

          <Panel
            title="Results"
            icon={<CheckCircle2 className="size-4" aria-hidden />}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
                {results.length
                  ? `${results.length} result rows`
                  : "No results yet."}
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
                Download results, filter to ERROR or THROTTLED, follow the
                next_step column, then rerun only those rows.
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
                      <tr
                        className="border-t border-zinc-200 dark:border-zinc-800"
                        key={`${result.rowNumber}-${index}`}
                      >
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.rowNumber}
                        </td>
                        <td className="px-3 py-2">
                          <ResultBadge status={result.status} />
                        </td>
                        <td className="px-3 py-2 font-medium text-zinc-950 dark:text-zinc-50">
                          {result.identifier}
                        </td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.sku}
                        </td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.locationName || result.locationId}
                        </td>
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.requestedValue}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                          {result.requestId}
                        </td>
                        <td className="max-w-md px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.message}
                        </td>
                        <td className="max-w-md px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {result.nextStep}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        className="px-3 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400"
                        colSpan={9}
                      >
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

function normalizeVerifiedAccount(value: unknown): VerifiedAccount {
  const source = isRecord(value) ? value : {};
  const customers = Array.isArray(source.customers)
    ? source.customers.filter(isShipHeroCustomerAccount)
    : [];

  return {
    email: stringValue(source.email),
    userId: stringValue(source.userId),
    accountId: stringValue(source.accountId),
    accountLegacyId:
      typeof source.accountLegacyId === "string" ||
      typeof source.accountLegacyId === "number"
        ? source.accountLegacyId
        : undefined,
    username: stringValue(source.username),
    is3pl: Boolean(source.is3pl),
    requestId: stringValue(source.requestId),
    customers,
    customerPageLimitReached: Boolean(source.customerPageLimitReached),
  };
}

function savedConnectionToAccount(
  connection: SavedConnection,
): VerifiedAccount {
  const customers =
    connection.mode === "3pl" && connection.childAccountId
      ? [
          {
            id: connection.childAccountId,
            displayName: connection.childAccountName || connection.label,
          },
        ]
      : [];

  return {
    email: connection.parentEmail ?? "",
    userId: "",
    accountId: connection.parentAccountId ?? "",
    username: connection.parentUsername ?? "",
    is3pl: connection.mode === "3pl",
    requestId: "Saved profile",
    customers,
    customerPageLimitReached: false,
  };
}

function isSavedConnection(value: unknown): value is SavedConnection {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.mode === "brand" || value.mode === "3pl") &&
    typeof value.clientId === "string" &&
    typeof value.refreshToken === "string"
  );
}

function readSavedConnections(): SavedConnection[] {
  try {
    const raw = window.localStorage.getItem(CONNECTIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isSavedConnection) : [];
  } catch {
    return [];
  }
}

function isShipHeroCustomerAccount(
  value: unknown,
): value is ShipHeroCustomerAccount {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.displayName === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function createConnectionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `connection-${Date.now()}`;
}

function operationIcon(operationId: BulkOperationId) {
  const className = "size-4 shrink-0";
  if (operationId === "lots")
    return <PackagePlus className={className} aria-hidden />;
  if (operationId === "product-case-barcodes")
    return <Barcode className={className} aria-hidden />;
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
    good: "border-teal-200 bg-teal-50 text-teal-950 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-50",
    bad: "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-50",
    warn: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-50",
  }[tone];

  return (
    <div className={`rounded-md border px-4 py-3 ${toneClass}`}>
      <div className="text-xs font-medium uppercase text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
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
      <dd className="min-w-0 break-words font-mono text-xs text-teal-950 dark:text-teal-50">
        {value}
      </dd>
    </div>
  );
}

function StatusBadge({ state }: { state: RunState }) {
  const settings = {
    idle: {
      label: "Ready",
      className:
        "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
      icon: CheckCircle2,
    },
    checking: {
      label: "Checking",
      className:
        "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100",
      icon: Loader2,
    },
    running: {
      label: "Running",
      className:
        "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100",
      icon: Loader2,
    },
    done: {
      label: "Done",
      className:
        "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-100",
      icon: CheckCircle2,
    },
    error: {
      label: "Needs attention",
      className:
        "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100",
      icon: XCircle,
    },
  }[state];
  const Icon = settings.icon;

  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold ${settings.className}`}
    >
      <Icon
        className={`size-3.5 ${state === "checking" || state === "running" ? "animate-spin" : ""}`}
        aria-hidden
      />
      {settings.label}
    </span>
  );
}

function ResultBadge({ status }: { status: BulkStatus }) {
  const settings = {
    DRY_RUN: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
    CREATED: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-100",
    UPDATED: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-100",
    SKIPPED:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100",
    ERROR: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100",
    THROTTLED:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-100",
  }[status];

  return (
    <span
      className={`inline-flex h-7 items-center rounded-md px-2 text-xs font-semibold ${settings}`}
    >
      {status}
    </span>
  );
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
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
