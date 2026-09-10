import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SourceTransport, SurfaceReceipt, TruthSource } from "./schema.js";

const execFileAsync = promisify(execFile);
const UA = "lp-truth-gateway/1.1";
const MAX_BODY = 4_000_000;
const MAX_ENDPOINTS = 12;
const now = () => new Date().toISOString();

export type SurfaceRead = {
  receipt: SurfaceReceipt;
  fetchedAt: string;
  text: string | null;
  structured: unknown;
  endpointUrls: string[];
};

type Options = {
  source: TruthSource;
  url: string;
  tokenAddress: string;
  allowedHosts: string[];
  browserFallback?: boolean;
};

function sha(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function safeUrl(raw: string, allowedHosts: string[]): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (!allowedHosts.includes(u.hostname.toLowerCase())) return null;
    return u;
  } catch { return null; }
}

async function getText(url: string): Promise<{ text: string | null; contentType: string; error: string | null }> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json,text/html;q=0.9,*/*;q=0.5", "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { text: null, contentType: r.headers.get("content-type") ?? "", error: `HTTP_${r.status}` };
    const text = (await r.text()).slice(0, MAX_BODY);
    return { text, contentType: r.headers.get("content-type") ?? "", error: null };
  } catch (e) { return { text: null, contentType: "", error: e instanceof Error ? e.message : "FETCH_FAILED" }; }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function decodeEntities(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function embeddedJson(html: string): unknown {
  const scripts = [...html.matchAll(/<script\b[^>]*(?:type=["']application\/(?:json|ld\+json)["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi)];
  const out: unknown[] = [];
  for (const m of scripts.slice(0, 20)) {
    const parsed = parseJson(decodeEntities((m[1] ?? "").trim()));
    if (parsed !== null) out.push(parsed);
  }
  return out.length ? out : null;
}

function discoverEndpoints(html: string, base: URL, allowedHosts: string[]): string[] {
  const raw = new Set<string>();
  const patterns = [
    /https:\/\/[^"'\s<>\\]+/g,
    /["'](\/[^"']*(?:api|graphql|_next\/data)[^"']*)["']/gi,
    /(?:fetch|axios\.(?:get|post))\(\s*["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) for (const m of html.matchAll(pattern)) raw.add(m[1] ?? m[0]);
  const out: string[] = [];
  for (const value of raw) {
    try {
      const u = new URL(value.replace(/&amp;/g, "&"), base);
      if (u.protocol !== "https:" || !allowedHosts.includes(u.hostname.toLowerCase())) continue;
      if (!/(api|graphql|_next\/data|pool|position|analytics|discover)/i.test(u.pathname + u.search)) continue;
      out.push(u.toString());
    } catch { /* invalid candidate */ }
  }
  return [...new Set(out)].slice(0, MAX_ENDPOINTS);
}

async function readDiscoveredEndpoint(urls: string[], tokenAddress: string): Promise<{ text: string; structured: unknown; url: string } | null> {
  const token = tokenAddress.toLowerCase();
  for (const url of urls) {
    const r = await getText(url);
    if (!r.text) continue;
    const parsed = parseJson(r.text);
    if (parsed === null) continue;
    const body = r.text.toLowerCase();
    if (body.includes(token)) return { text: r.text, structured: parsed, url };
  }
  return null;
}

async function chromePath(): Promise<string | null> {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((x): x is string => Boolean(x));
  for (const p of candidates) try { await access(p); return p; } catch { /* continue */ }
  return null;
}

async function browserDump(url: string, allowedHosts: string[]): Promise<{ html: string; endpointUrls: string[] } | null> {
  const chrome = await chromePath();
  if (!chrome) return null;
  const dir = await mkdtemp(join(tmpdir(), "lp-surface-"));
  const netlog = join(dir, "netlog.json");
  try {
    const { stdout } = await execFileAsync(chrome, [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      `--user-data-dir=${dir}`, `--log-net-log=${netlog}`, "--net-log-capture-mode=Default",
      "--virtual-time-budget=8000", "--dump-dom", url,
    ], { timeout: 20_000, maxBuffer: MAX_BODY });
    let endpointUrls = discoverEndpoints(stdout, new URL(url), allowedHosts);
    try {
      const log = JSON.parse(await readFile(netlog, "utf8")) as { events?: Array<{ params?: { url?: string; method?: string } }> };
      const observed = (log.events ?? []).flatMap((e) => e.params?.url ? [e.params.url] : []).filter((x) => Boolean(safeUrl(x, allowedHosts)));
      endpointUrls = [...new Set([...endpointUrls, ...observed.filter((x) => /(api|graphql|pool|position|analytics|discover)/i.test(x))])].slice(0, MAX_ENDPOINTS);
    } catch { /* netlog is optional evidence */ }
    return { html: stdout.slice(0, MAX_BODY), endpointUrls };
  } catch { return null; }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function receipt(source: TruthSource, url: string, transport: SourceTransport, text: string | null, structured: unknown, endpoints: string[], tokenAddress: string, error: string | null): SurfaceReceipt {
  const matched = text?.toLowerCase().includes(tokenAddress.toLowerCase()) ?? false;
  return {
    source, url, transport,
    status: matched ? "READY" : "BLOCKED",
    addressMatched: matched,
    structuredPayload: structured !== null,
    discoveredEndpoints: endpoints.length,
    contentSha256: text ? sha(text) : null,
    error: matched ? null : (error ?? "TOKEN_NOT_FOUND_ON_PUBLIC_SURFACE"),
  };
}

export async function readPublicSurface(options: Options): Promise<SurfaceRead> {
  const { source, tokenAddress, allowedHosts } = options;
  const base = safeUrl(options.url, allowedHosts);
  if (!base) {
    const r = receipt(source, options.url, "NONE", null, null, [], tokenAddress, "UNSAFE_OR_UNAPPROVED_URL");
    return { receipt: r, fetchedAt: now(), text: null, structured: null, endpointUrls: [] };
  }

  const direct = await getText(base.toString());
  if (!direct.text) {
    const r = receipt(source, base.toString(), "NONE", null, null, [], tokenAddress, direct.error);
    return { receipt: r, fetchedAt: now(), text: null, structured: null, endpointUrls: [] };
  }

  const directJson = /json/i.test(direct.contentType) ? parseJson(direct.text) : null;
  if (directJson !== null && direct.text.toLowerCase().includes(tokenAddress.toLowerCase())) {
    const r = receipt(source, base.toString(), "PUBLIC_ENDPOINT", direct.text, directJson, [], tokenAddress, null);
    return { receipt: r, fetchedAt: now(), text: direct.text, structured: directJson, endpointUrls: [] };
  }

  const embedded = embeddedJson(direct.text);
  const staticEndpoints = discoverEndpoints(direct.text, base, allowedHosts);
  const endpoint = await readDiscoveredEndpoint(staticEndpoints, tokenAddress);
  if (endpoint) {
    const r = receipt(source, endpoint.url, "DISCOVERED_ENDPOINT", endpoint.text, endpoint.structured, staticEndpoints, tokenAddress, null);
    return { receipt: r, fetchedAt: now(), text: endpoint.text, structured: endpoint.structured, endpointUrls: staticEndpoints };
  }
  if (direct.text.toLowerCase().includes(tokenAddress.toLowerCase())) {
    const r = receipt(source, base.toString(), "HTML_DOM", direct.text, embedded, staticEndpoints, tokenAddress, null);
    return { receipt: r, fetchedAt: now(), text: direct.text, structured: embedded, endpointUrls: staticEndpoints };
  }

  if (options.browserFallback !== false) {
    const browser = await browserDump(base.toString(), allowedHosts);
    if (browser) {
      const browserEndpoint = await readDiscoveredEndpoint(browser.endpointUrls, tokenAddress);
      if (browserEndpoint) {
        const r = receipt(source, browserEndpoint.url, "DISCOVERED_ENDPOINT", browserEndpoint.text, browserEndpoint.structured, browser.endpointUrls, tokenAddress, null);
        return { receipt: r, fetchedAt: now(), text: browserEndpoint.text, structured: browserEndpoint.structured, endpointUrls: browser.endpointUrls };
      }
      const rendered = embeddedJson(browser.html);
      const r = receipt(source, base.toString(), "BROWSER_DOM", browser.html, rendered, browser.endpointUrls, tokenAddress, null);
      return { receipt: r, fetchedAt: now(), text: browser.html, structured: rendered, endpointUrls: browser.endpointUrls };
    }
  }

  const r = receipt(source, base.toString(), "HTML_DOM", direct.text, embedded, staticEndpoints, tokenAddress, "TOKEN_NOT_FOUND_ON_PUBLIC_SURFACE");
  return { receipt: r, fetchedAt: now(), text: direct.text, structured: embedded, endpointUrls: staticEndpoints };
}

export async function probePublicEnhancements(tokenAddress: string): Promise<SurfaceRead[]> {
  const address = tokenAddress.toLowerCase();
  return Promise.all([
    readPublicSurface({
      source: "revert",
      url: `https://revert.finance/discover?pool=${encodeURIComponent(address)}`,
      tokenAddress: address,
      allowedHosts: ["revert.finance", "www.revert.finance"],
      browserFallback: true,
    }),
  ]);
}
