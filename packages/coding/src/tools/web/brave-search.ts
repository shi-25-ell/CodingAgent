import type { CredentialResolver } from "@coding-agent/model/auth";
import { credentialRef } from "@coding-agent/model/auth";
import type { WebSearchOutcome, WebSearchProvider, WebSearchResult } from "./contracts.js";

export interface WebSearchTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface WebSearchTransportResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface WebSearchTransport {
  send(request: WebSearchTransportRequest): Promise<WebSearchTransportResponse>;
}

function defaultTransport(): WebSearchTransport {
  return {
    async send(request) {
      const response = await fetch(request.url, {
        method: "GET",
        headers: request.headers,
        signal: request.signal,
      });
      return { status: response.status, json: () => response.json() };
    },
  };
}

function parseResults(value: unknown, maximum: number): readonly WebSearchResult[] {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("search response root 必须是 object");
  }
  const web = (value as Record<string, unknown>).web;
  if (web === null || Array.isArray(web) || typeof web !== "object") {
    throw new TypeError("search response web 必须是 object");
  }
  const results = (web as Record<string, unknown>).results;
  if (!Array.isArray(results)) throw new TypeError("search response results 必须是 array");
  return results.slice(0, maximum).map((candidate) => {
    if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
      throw new TypeError("search result 必须是 object");
    }
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.title !== "string" || typeof raw.url !== "string") {
      throw new TypeError("search result title/url 必须是 string");
    }
    const url = new URL(raw.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("search result URL protocol 无效");
    }
    return {
      title: raw.title,
      url: url.toString(),
      snippet: typeof raw.description === "string" ? raw.description : "",
    };
  });
}

export function createBraveWebSearchProvider(options: {
  readonly credentials: CredentialResolver;
  readonly transport?: WebSearchTransport;
}): WebSearchProvider {
  const transport = options.transport ?? defaultTransport();
  return {
    id: "brave",
    async search(input, callOptions): Promise<WebSearchOutcome> {
      const timeout = AbortSignal.timeout(callOptions.timeoutMs);
      const signal = AbortSignal.any([callOptions.signal, timeout]);
      try {
        const resolution = await options.credentials.resolve(
          { ref: credentialRef("web.brave"), kind: "api_key" },
          { signal },
        );
        if (resolution.status === "missing") {
          return { status: "not_configured", message: "Brave Search credential 未配置" };
        }
        if (resolution.status === "failed") {
          return resolution.failure.category === "cancelled"
            ? { status: "cancelled", message: "web_search 已取消" }
            : { status: "failed", message: "Brave Search credential 解析失败" };
        }
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", input.query);
        url.searchParams.set("count", String(input.maximumResults));
        const response = await transport.send({
          url: url.toString(),
          headers: {
            accept: "application/json",
            "x-subscription-token": resolution.credential.value.reveal(),
          },
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          return { status: "failed", message: `Brave Search request failed (${response.status})` };
        }
        return {
          status: "succeeded",
          results: parseResults(await response.json(), input.maximumResults),
        };
      } catch (_error) {
        if (callOptions.signal.aborted)
          return { status: "cancelled", message: "web_search 已取消" };
        if (timeout.aborted) return { status: "timed_out", message: "web_search 超时" };
        return { status: "failed", message: "Brave Search response 无效" };
      }
    },
  };
}
