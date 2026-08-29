import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { WebFetchOutcome, WebFetchPort } from "./contracts.js";

export interface WebAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface WebAddressResolver {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly WebAddress[]>;
}

export interface PinnedHttpRequest {
  readonly url: URL;
  readonly address: WebAddress;
  readonly signal: AbortSignal;
  readonly maximumHeaderBytes: number;
  readonly headerTimeoutMs: number;
}

export interface PinnedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface PinnedHttpTransport {
  get(request: PinnedHttpRequest): Promise<PinnedHttpResponse>;
}

interface FetchLimits {
  readonly maximumRedirects: number;
  readonly maximumHeaderBytes: number;
  readonly maximumBodyBytes: number;
  readonly maximumTextCharacters: number;
  readonly headerTimeoutMs: number;
}

const defaults: FetchLimits = {
  maximumRedirects: 5,
  maximumHeaderBytes: 32 * 1_024,
  maximumBodyBytes: 2 * 1_024 * 1_024,
  maximumTextCharacters: 512 * 1_024,
  headerTimeoutMs: 10_000,
};

function defaultResolver(): WebAddressResolver {
  return {
    async resolve(hostname, signal) {
      if (signal.aborted) throw signal.reason;
      const result = await lookup(hostname, { all: true, verbatim: true });
      if (signal.aborted) throw signal.reason;
      return result.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
    },
  };
}

function raceAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function defaultTransport(): PinnedHttpTransport {
  return {
    get(input) {
      return new Promise<PinnedHttpResponse>((resolve, reject) => {
        const client = input.url.protocol === "https:" ? https : http;
        const request = client.request(input.url, {
          method: "GET",
          agent: false,
          signal: input.signal,
          maxHeaderSize: input.maximumHeaderBytes,
          headers: {
            accept: "text/plain, text/html, application/json",
            "accept-encoding": "identity",
            "user-agent": "Dex-Code/1 web_fetch",
          },
          lookup: (_hostname, _options, callback) => {
            callback(null, input.address.address, input.address.family);
          },
        });
        const timer = setTimeout(() => {
          const error = new Error("response headers timed out");
          error.name = "TimeoutError";
          request.destroy(error);
        }, input.headerTimeoutMs);
        request.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        request.once("response", (response) => {
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: (async function* () {
              try {
                for await (const chunk of response) yield new Uint8Array(chunk as Buffer);
              } finally {
                response.destroy();
              }
            })(),
          });
        });
        request.end();
      });
    },
  };
}

function ipv4Bytes(address: string): readonly number[] | undefined {
  const values = address.split(".");
  if (values.length !== 4) return undefined;
  const bytes = values.map((value) => Number(value));
  return bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? bytes
    : undefined;
}

function isPublicIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return false;
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function normalizedIpv6(address: string): string {
  return address.toLowerCase().split("%")[0] ?? address.toLowerCase();
}

function ipv6Words(address: string): readonly number[] | undefined {
  let value = normalizedIpv6(address);
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  if (dotted) {
    const bytes = ipv4Bytes(dotted);
    if (!bytes) return undefined;
    value =
      value.slice(0, value.length - dotted.length) +
      `${(((bytes[0] as number) << 8) | (bytes[1] as number)).toString(16)}:` +
      `${(((bytes[2] as number) << 8) | (bytes[3] as number)).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) {
    return undefined;
  }
  return words.map((word) => Number.parseInt(word, 16));
}

function embeddedIpv4IsPublic(high: number, low: number): boolean {
  return isPublicIpv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
}

function isPublicIpv6(address: string): boolean {
  const value = normalizedIpv6(address);
  const words = ipv6Words(value);
  if (!words) return false;
  if (value === "::" || value === "::1") return false;
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)) return false;
  if (/^2001:db8(?::|$)/.test(value)) return false;
  if (/^2001:(?:0|1[0-9a-f])(?::|$)/.test(value)) return false;
  const [
    first = 0,
    second = 0,
    third = 0,
    fourth = 0,
    fifth = 0,
    sixth = 0,
    seventh = 0,
    eighth = 0,
  ] = words;
  if (
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0xffff
  ) {
    return embeddedIpv4IsPublic(seventh, eighth);
  }
  if (
    first === 0x64 &&
    second === 0xff9b &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0
  ) {
    return embeddedIpv4IsPublic(seventh, eighth);
  }
  if (first === 0x64 && second === 0xff9b && third === 1) return false;
  if (first === 0x2002) return embeddedIpv4IsPublic(second, third);
  return true;
}

function isPublicAddress(address: WebAddress): boolean {
  return address.family === 4 ? isPublicIpv4(address.address) : isPublicIpv6(address.address);
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("web_fetch URL 必须是 absolute HTTP/HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("web_fetch 只允许 HTTP/HTTPS");
  }
  if (url.username || url.password) throw new TypeError("web_fetch URL 禁止 userinfo");
  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) throw new TypeError("web_fetch 禁止 non-default port");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new TypeError("web_fetch 禁止 local hostname");
  }
  return url;
}

async function resolvePublicAddress(
  url: URL,
  resolver: WebAddressResolver,
  signal: AbortSignal,
): Promise<WebAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses: readonly WebAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await raceAbort(resolver.resolve(hostname, signal), signal);
  if (addresses.length === 0) throw new TypeError("web_fetch DNS 未返回地址");
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new TypeError("web_fetch 拒绝 private/reserved/local address");
  }
  return addresses[0] as WebAddress;
}

function mediaType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [type, ...parameters] = value.split(";").map((part) => part.trim().toLowerCase());
  const charset = parameters
    .map((parameter) => /^charset=(.+)$/.exec(parameter)?.[1]?.replace(/^"|"$/g, ""))
    .find(Boolean);
  if (charset && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii")
    return undefined;
  if (type === "text/plain" || type === "text/html" || type === "application/json") return type;
  if (type?.startsWith("application/") && type.endsWith("+json")) return type;
  return undefined;
}

function htmlToText(value: string): string {
  return value
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function failure(error: unknown, callerSignal: AbortSignal, timeout: AbortSignal): WebFetchOutcome {
  if (callerSignal.aborted) return { status: "cancelled", message: "web_fetch 已取消" };
  if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) {
    return { status: "timed_out", message: "web_fetch 超时" };
  }
  if (error instanceof TypeError) return { status: "rejected", message: error.message };
  return { status: "failed", message: "web_fetch request failed" };
}

export function createSafeWebFetchPort(options?: {
  readonly resolver?: WebAddressResolver;
  readonly transport?: PinnedHttpTransport;
  readonly limits?: Partial<FetchLimits>;
}): WebFetchPort {
  const resolver = options?.resolver ?? defaultResolver();
  const transport = options?.transport ?? defaultTransport();
  const limits = { ...defaults, ...options?.limits };
  return {
    async fetch(request): Promise<WebFetchOutcome> {
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      try {
        let url = parseUrl(request.url);
        const visited = new Set<string>();
        for (let redirects = 0; redirects <= limits.maximumRedirects; redirects += 1) {
          if (visited.has(url.toString())) throw new TypeError("web_fetch redirect loop");
          visited.add(url.toString());
          const address = await resolvePublicAddress(url, resolver, signal);
          const response = await raceAbort(
            transport.get({
              url,
              address,
              signal,
              maximumHeaderBytes: limits.maximumHeaderBytes,
              headerTimeoutMs: Math.min(limits.headerTimeoutMs, request.timeoutMs),
            }),
            signal,
          );
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.location;
            if (!location) throw new TypeError("web_fetch redirect 缺少 Location");
            if (redirects === limits.maximumRedirects) {
              throw new TypeError("web_fetch redirect 超过上限");
            }
            const next = parseUrl(new URL(location, url).toString());
            if (url.protocol === "https:" && next.protocol !== "https:") {
              throw new TypeError("web_fetch 拒绝 HTTPS downgrade");
            }
            url = next;
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            return { status: "failed", message: `web_fetch HTTP ${response.status}` };
          }
          if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          ) {
            return { status: "rejected", message: "web_fetch 不接受 compressed response" };
          }
          const contentType = mediaType(response.headers["content-type"]);
          if (!contentType)
            return { status: "rejected", message: "web_fetch content type 不受支持" };
          const declaredLength = Number(response.headers["content-length"]);
          if (Number.isFinite(declaredLength) && declaredLength > limits.maximumBodyBytes) {
            return { status: "output_limit", message: "web_fetch body 超过上限" };
          }
          const chunks: Uint8Array[] = [];
          let bodyBytes = 0;
          const iterator = response.body[Symbol.asyncIterator]();
          let iteratorCompleted = false;
          try {
            while (true) {
              const next = await raceAbort(iterator.next(), signal);
              if (next.done) {
                iteratorCompleted = true;
                break;
              }
              const chunk = next.value;
              bodyBytes += chunk.byteLength;
              if (bodyBytes > limits.maximumBodyBytes) {
                return { status: "output_limit", message: "web_fetch body 超过上限" };
              }
              chunks.push(chunk);
            }
          } finally {
            if (!iteratorCompleted && iterator.return) {
              void Promise.resolve(iterator.return()).catch(() => {});
            }
          }
          const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            return { status: "rejected", message: "web_fetch body 不是有效 UTF-8" };
          }
          if (contentType === "text/html") text = htmlToText(text);
          if (text.length > limits.maximumTextCharacters) {
            return { status: "output_limit", message: "web_fetch text 超过上限" };
          }
          return {
            status: "succeeded",
            finalUrl: url.toString(),
            httpStatus: response.status,
            contentType,
            text,
            redirects,
            bodyBytes,
          };
        }
        throw new TypeError("web_fetch redirect 超过上限");
      } catch (error) {
        return failure(error, request.signal, timeout);
      }
    },
  };
}
