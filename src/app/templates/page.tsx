"use client";

import {
  ArrowLeft,
  Barcode,
  Download,
  MapPin,
  Moon,
  PackagePlus,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  BULK_OPERATIONS,
  templateCsvForOperation,
  type BulkOperationId,
} from "@/lib/bulk";

type ThemeMode = "light" | "dark";

export default function TemplatesPage() {
  const [theme, setTheme] = useState<ThemeMode>("light");

  return (
    <main
      className={`${theme === "dark" ? "dark " : ""}min-h-screen bg-stone-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50`}
    >
      <section className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="min-w-0">
            <p className="text-sm font-medium text-teal-700 dark:text-teal-300">
              ShipHero bulk updater
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-950 sm:text-3xl dark:text-zinc-50">
              CSV Templates
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="btn-secondary" href="/">
              <ArrowLeft className="size-4" aria-hidden />
              Bulk tools
            </Link>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
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

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-2 lg:px-8">
        {BULK_OPERATIONS.map((operation) => {
          const template = templateCsvForOperation(operation.id);

          return (
            <article
              className="min-w-0 rounded-md border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70"
              key={operation.id}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                    <span className="flex size-7 items-center justify-center rounded-md bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                      {operationIcon(operation.id)}
                    </span>
                    {operation.title}
                  </div>
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    {operation.summary}
                  </p>
                </div>
                <button
                  className="btn-primary shrink-0"
                  type="button"
                  onClick={() =>
                    downloadText(operation.templateFileName, template)
                  }
                >
                  <Download className="size-4" aria-hidden />
                  Download CSV
                </button>
              </div>

              <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <TemplateField
                  label="Required"
                  values={operation.requiredColumns}
                />
                <TemplateField
                  label="Optional"
                  values={operation.optionalColumns}
                />
              </div>

              <textarea
                className="field-textarea mt-4 min-h-32 font-mono text-xs"
                readOnly
                value={template}
              />
            </article>
          );
        })}
      </section>
    </main>
  );
}

function TemplateField({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      <div className="mt-1 text-zinc-800 dark:text-zinc-100">
        {values.length ? values.join(", ") : "None"}
      </div>
    </div>
  );
}

function operationIcon(operationId: BulkOperationId) {
  const className = "size-4";
  if (operationId === "lots")
    return <PackagePlus className={className} aria-hidden />;
  if (operationId === "product-case-barcodes") {
    return <Barcode className={className} aria-hidden />;
  }
  return <MapPin className={className} aria-hidden />;
}

function downloadText(fileName: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
