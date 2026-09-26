"use client";

import { FormEvent, useState } from "react";

type SitemapUrl = {
  loc: string;
  lastmod?: string;
};

type ExtractionResult = {
  urls: SitemapUrl[];
  sitemapCount: number;
  truncated: boolean;
};

const exampleSitemap = "https://timesofindia.indiatimes.com/sitemap/today";
const URL_LIMIT = 10_000;

function csvValue(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export default function Home() {
  const [sitemapUrl, setSitemapUrl] = useState(exampleSitemap);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [batchSize, setBatchSize] = useState(50);
  const [batchIndex, setBatchIndex] = useState(0);

  const filteredUrls = result?.urls.filter((item) =>
    `${item.loc} ${item.lastmod ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  ) ?? [];
  const batchCount = Math.ceil(filteredUrls.length / batchSize);
  const activeBatch = Math.min(batchIndex, Math.max(0, batchCount - 1));
  const batchStart = activeBatch * batchSize;
  const batchUrls = filteredUrls.slice(batchStart, batchStart + batchSize);

  async function extractUrls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    setSearch("");
    setBatchIndex(0);

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sitemapUrl }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Could not read this sitemap.");
      }

      setResult(data as ExtractionResult);
      if (data.truncated) {
        setNotice(`Showing the first ${URL_LIMIT.toLocaleString()} URLs. The sitemap contains more entries.`);
      } else if (data.urls.length === 0) {
        setNotice("This sitemap was valid, but it did not contain any page URLs.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function copyBatch() {
    if (batchUrls.length === 0) return;
    try {
      await navigator.clipboard.writeText(batchUrls.map((item) => item.loc).join("\n"));
      setNotice(`Copied URLs ${batchStart + 1}–${batchStart + batchUrls.length} (${batchUrls.length.toLocaleString()} URLs).`);
    } catch {
      setError("Clipboard access was blocked by your browser.");
    }
  }

  async function copyAllUrls() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.urls.map((item) => item.loc).join("\n"));
      setNotice(`${result.urls.length.toLocaleString()} URLs copied to clipboard.`);
    } catch {
      setError("Clipboard access was blocked by your browser.");
    }
  }

  function downloadCsv() {
    if (!result) return;
    const rows = [
      ["URL", "Last modified"],
      ...result.urls.map((item) => [item.loc, item.lastmod ?? ""]),
    ];
    const csv = rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "sitemap-urls.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Sitemap Studio home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Sitemap <strong>Studio</strong></span>
        </a>
        <div className="topbar-meta"><span className="status-dot" /> XML EXTRACTOR <span className="meta-divider">/</span> UP TO 10,000 URLS</div>
      </header>

      <section className="intro" id="top">
        <div className="eyebrow"><span className="eyebrow-line" /> SITEMAP WORKSPACE</div>
        <h1>Every page,<br /><em>in one place.</em></h1>
        <p className="intro-copy">Turn a publisher sitemap into a clean, spreadsheet-ready list. Paste a sitemap URL to get started.</p>
      </section>

      <section className="extract-panel" aria-label="Extract URLs from a sitemap">
        <form onSubmit={extractUrls}>
          <label className="field-label" htmlFor="sitemap-url">SITEMAP URL</label>
          <div className="input-row">
            <div className="input-wrap">
              <span className="input-prefix" aria-hidden="true">↳</span>
              <input
                id="sitemap-url"
                type="url"
                required
                value={sitemapUrl}
                onChange={(event) => setSitemapUrl(event.target.value)}
                placeholder="https://example.com/sitemap.xml"
                autoComplete="url"
              />
            </div>
            <button className="extract-button" type="submit" disabled={busy}>
              {busy ? <><span className="spinner" /> Extracting</> : <>Extract URLs <span aria-hidden="true">↗</span></>}
            </button>
          </div>
          <div className="form-footnote">
            <span>Try an example</span>
            <button type="button" className="sample-link" onClick={() => setSitemapUrl(exampleSitemap)}>Times of India · Today</button>
            <span className="supported-note">Supports TOI and ET sitemaps</span>
          </div>
        </form>
      </section>

      {error && <div className="feedback error-feedback" role="alert">{error}</div>}
      {notice && <div className="feedback" role="status">{notice}</div>}

      <section className="results" aria-label="Extracted URLs">
        <div className="results-heading">
          <div>
            <div className="section-kicker">OUTPUT</div>
            <h2>{result ? "Extracted URLs" : "Your results"}</h2>
          </div>
          {result && <div className="result-count"><strong>{result.urls.length.toLocaleString()}</strong><span> / {URL_LIMIT.toLocaleString()}</span></div>}
        </div>

        {result ? (
          <>
            <div className="results-tools">
              <label className="search-box">
                <span aria-hidden="true">⌕</span>
                <input value={search} onChange={(event) => { setSearch(event.target.value); setBatchIndex(0); }} placeholder="Filter URLs or dates" aria-label="Filter results" />
                {search && <button type="button" onClick={() => { setSearch(""); setBatchIndex(0); }} aria-label="Clear filter">×</button>}
              </label>
              <div className="export-actions">
                <button type="button" className="quiet-button" onClick={copyAllUrls} title="Copy all extracted URLs">Copy all</button>
                <button type="button" className="download-button" onClick={downloadCsv}><span aria-hidden="true">↓</span> Export CSV</button>
              </div>
            </div>
            <div className="batch-toolbar">
              <label className="batch-setting" htmlFor="batch-size">
                <span>URLS PER BATCH</span>
                <input
                  id="batch-size"
                  type="number"
                  min={1}
                  max={URL_LIMIT}
                  step={1}
                  value={batchSize}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setBatchSize(Math.min(URL_LIMIT, Math.max(1, Number.isFinite(value) ? value : 50)));
                    setBatchIndex(0);
                  }}
                />
              </label>
              <div className="batch-pager" aria-label="Batch navigation">
                <button type="button" onClick={() => setBatchIndex(Math.max(0, activeBatch - 1))} disabled={activeBatch === 0} aria-label="Previous batch">←</button>
                <span><strong>Batch {batchCount ? activeBatch + 1 : 0} / {batchCount}</strong><small>{batchUrls.length ? `URLs ${batchStart + 1}–${batchStart + batchUrls.length}` : "No URLs"}</small></span>
                <button type="button" onClick={() => setBatchIndex(Math.min(batchCount - 1, activeBatch + 1))} disabled={activeBatch >= batchCount - 1} aria-label="Next batch">→</button>
              </div>
              <button type="button" className="batch-copy-button" onClick={copyBatch} disabled={batchUrls.length === 0}>Copy batch <span>({batchUrls.length})</span></button>
            </div>
            <div className="table-shell">
              <div className="table-scroll">
                <table>
                  <thead><tr><th className="number-col">#</th><th>URL</th><th className="date-col">LAST MODIFIED</th></tr></thead>
                  <tbody>
                    {batchUrls.map((item, index) => (
                      <tr key={`${item.loc}-${index}`}>
                        <td className="row-number">{String(batchStart + index + 1).padStart(3, "0")}</td>
                        <td className="url-cell"><a href={item.loc} target="_blank" rel="noreferrer">{item.loc}</a></td>
                        <td className="date-cell">{item.lastmod || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredUrls.length === 0 && <div className="empty-filter">No URLs match “{search}”.</div>}
              </div>
              <div className="table-footer"><span>Showing {batchUrls.length ? `${batchStart + 1}–${batchStart + batchUrls.length}` : "0"} of {filteredUrls.length.toLocaleString()} matching URLs</span><span>{batchCount} batch{batchCount === 1 ? "" : "es"} · {result.sitemapCount} sitemap{result.sitemapCount === 1 ? "" : "s"} scanned</span></div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true"><span /><span /><span /></div>
            <div><strong>Nothing extracted yet</strong><p>Your URLs will appear here, ready to review and export.</p></div>
            <span className="empty-limit">MAX 10,000</span>
          </div>
        )}
      </section>

      <footer className="page-footer"><span>BUILT FOR EDITORIAL RESEARCH</span><span>XML IN <b>·</b> URLS OUT</span></footer>
    </main>
  );
}
