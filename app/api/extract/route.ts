import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const runtime = "nodejs";

const URL_LIMIT = 1000;
const SITEMAP_LIMIT = 25;
const RESPONSE_LIMIT = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const execFileAsync = promisify(execFile);
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

type SitemapEntry = {
  loc?: unknown;
  lastmod?: unknown;
};

type SitemapResponse = {
  status: number;
  location: string | null;
  body: string;
};

function isCertificateError(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined;
  return (
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  );
}

function allowedSitemapUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const trustedHost = hostname === "indiatimes.com" || hostname.endsWith(".indiatimes.com");
  if (
    url.protocol !== "https:" ||
    !trustedHost ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url;
}

async function fetchWithWindowsCurl(url: URL): Promise<SitemapResponse> {
  const { stdout } = await execFileAsync(
    "curl.exe",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(REQUEST_TIMEOUT_MS / 1000),
      "--max-filesize",
      String(RESPONSE_LIMIT),
      "--proto",
      "=https",
      "--dump-header",
      "-",
      "--output",
      "-",
      "--write-out",
      "\n<SITEMAP_STATUS>%{http_code}",
      "--header",
      "Accept: application/xml,text/xml;q=0.9,*/*;q=0.5",
      url.toString(),
    ],
    { encoding: "utf8", maxBuffer: RESPONSE_LIMIT + 256 * 1024, windowsHide: true },
  );

  const statusMarker = "\n<SITEMAP_STATUS>";
  const markerIndex = stdout.lastIndexOf(statusMarker);
  if (markerIndex < 0) throw new Error("Windows curl returned an invalid response.");
  const status = Number(stdout.slice(markerIndex + statusMarker.length).trim());
  const responseText = stdout.slice(0, markerIndex);
  const headerPattern = /HTTP\/\S+\s+\d{3}[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/g;
  let finalHeader: RegExpExecArray | null = null;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(responseText)) !== null) {
    finalHeader = headerMatch;
  }
  if (!finalHeader) throw new Error("Windows curl returned invalid sitemap headers.");

  const location = finalHeader[1]
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith("location:"))
    ?.slice("location:".length)
    .trim() ?? null;

  return {
    status,
    location,
    body: responseText.slice(finalHeader.index! + finalHeader[0].length),
  };
}

async function requestSitemap(url: URL): Promise<SitemapResponse> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      return { status: response.status, location, body: "" };
    }
    if (!response.ok) return { status: response.status, location: null, body: "" };
    if (!response.body) throw new Error("The sitemap response was empty.");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("The sitemap is larger than the 5 MB processing limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: response.status, location: null, body: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (process.platform === "win32" && isCertificateError(error)) {
      return fetchWithWindowsCurl(url);
    }
    throw error;
  }
}

async function fetchSitemap(startUrl: URL) {
  let currentUrl = startUrl;

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await requestSitemap(currentUrl);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirects === 3) {
        throw new Error("The sitemap redirected too many times.");
      }
      const nextUrl = allowedSitemapUrl(new URL(response.location, currentUrl).toString());
      if (!nextUrl) throw new Error("The sitemap redirected to an unsupported host.");
      currentUrl = nextUrl;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The sitemap server returned HTTP ${response.status}.`);
    }
    return response.body;
  }

  throw new Error("The sitemap redirected too many times.");
}

function asEntries(value: unknown): SitemapEntry[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as SitemapEntry[];
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  let body: { sitemapUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a valid JSON request." }, { status: 400 });
  }

  if (typeof body.sitemapUrl !== "string" || body.sitemapUrl.length > 2048) {
    return Response.json({ error: "Enter a valid sitemap URL." }, { status: 400 });
  }

  const startUrl = allowedSitemapUrl(body.sitemapUrl);
  if (!startUrl) {
    return Response.json(
      { error: "Use an HTTPS sitemap hosted on a *.indiatimes.com domain." },
      { status: 400 },
    );
  }

  const pending = [startUrl.toString()];
  const visited = new Set<string>();
  const seenUrls = new Set<string>();
  const urls: { loc: string; lastmod?: string }[] = [];
  let truncated = false;

  try {
    while (pending.length > 0 && visited.size < SITEMAP_LIMIT && urls.length < URL_LIMIT) {
      const sitemap = pending.shift()!;
      if (visited.has(sitemap)) continue;
      visited.add(sitemap);

      const xml = await fetchSitemap(new URL(sitemap));
      const validation = XMLValidator.validate(xml);
      if (validation !== true) throw new Error("The sitemap contains invalid XML.");

      const parsed = parser.parse(xml) as Record<string, unknown>;
      const index = parsed.sitemapindex as { sitemap?: unknown } | undefined;
      if (index?.sitemap !== undefined) {
        for (const child of asEntries(index.sitemap)) {
          const location = textValue(child.loc);
          const childUrl = allowedSitemapUrl(location);
          if (childUrl && !visited.has(childUrl.toString())) pending.push(childUrl.toString());
        }
        continue;
      }

      const urlset = parsed.urlset as { url?: unknown } | undefined;
      if (urlset?.url === undefined) {
        throw new Error("This XML document is not a sitemap or sitemap index.");
      }

      const entries = asEntries(urlset.url);
      for (const entry of entries) {
        const location = textValue(entry.loc);
        if (!/^https?:\/\//i.test(location) || seenUrls.has(location)) continue;
        if (urls.length === URL_LIMIT) {
          truncated = true;
          break;
        }
        seenUrls.add(location);
        const lastmod = textValue(entry.lastmod);
        urls.push(lastmod ? { loc: location, lastmod } : { loc: location });
      }
      if (urls.length === URL_LIMIT && (entries.length > urls.length || pending.length > 0)) {
        truncated = true;
      }
    }

    if (pending.length > 0 || visited.size === SITEMAP_LIMIT) truncated = true;
    return Response.json({ urls, sitemapCount: visited.size, truncated });
  } catch (error) {
    if (isCertificateError(error)) {
      return Response.json(
        {
          error:
            "Node could not verify the sitemap server's certificate. Restart the app with the updated npm script; if it persists, add your network's root certificate to the Windows trusted certificate store.",
        },
        { status: 502 },
      );
    }
    const message = error instanceof Error ? error.message : "Could not extract this sitemap.";
    const status = message.startsWith("The sitemap URL") ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
}