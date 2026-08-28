import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId } from "@coding-agent/agent";
import { createCredentialResolver, SecretString } from "@coding-agent/model/auth";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBraveWebSearchProvider,
  createCodingToolHost,
  createSafeWebFetchPort,
  type PinnedHttpRequest,
  type PinnedHttpTransport,
  type WebAddressResolver,
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

async function bytes(value: string): Promise<AsyncIterable<Uint8Array>> {
  return (async function* () {
    yield Buffer.from(value, "utf8");
  })();
}

describe("M5 web safety and ToolExecutor contract", () => {
  it("web_fetch validates every redirect hop, pins the approved address and extracts bounded text", async () => {
    const resolutions: string[] = [];
    const requests: PinnedHttpRequest[] = [];
    const resolver: WebAddressResolver = {
      async resolve(hostname) {
        resolutions.push(hostname);
        return hostname === "first.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "2606:4700:4700::1111", family: 6 }];
      },
    };
    const transport: PinnedHttpTransport = {
      async get(request) {
        requests.push(request);
        if (request.url.hostname === "first.example") {
          return {
            status: 302,
            headers: { location: "https://second.example/docs" },
            body: await bytes(""),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "content-length": "76" },
          body: await bytes(
            "<html><script>steal()</script><body>Hello <b>public</b> web</body></html>",
          ),
        };
      },
    };
    const fetcher = createSafeWebFetchPort({ resolver, transport });
    await expect(
      fetcher.fetch({
        url: "https://first.example/start",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      finalUrl: "https://second.example/docs",
      redirects: 1,
      text: "Hello public web",
    });
    expect(resolutions).toEqual(["first.example", "second.example"]);
    expect(requests.map((request) => request.address.address)).toEqual([
      "93.184.216.34",
      "2606:4700:4700::1111",
    ]);
  });

  it.each([
    ["private IPv4", "https://private.example", [{ address: "10.1.2.3", family: 4 as const }]],
    ["reserved IPv4", "https://reserved.example", [{ address: "203.0.113.4", family: 4 as const }]],
    ["loopback IPv6", "https://loop.example", [{ address: "::1", family: 6 as const }]],
    [
      "mixed DNS",
      "https://mixed.example",
      [
        { address: "93.184.216.34", family: 4 as const },
        { address: "192.168.1.2", family: 4 as const },
      ],
    ],
  ])("rejects %s before opening a connection", async (_label, url, addresses) => {
    let sent = false;
    const fetcher = createSafeWebFetchPort({
      resolver: {
        async resolve() {
          return addresses;
        },
      },
      transport: {
        async get() {
          sent = true;
          throw new Error("must not connect");
        },
      },
    });
    await expect(
      fetcher.fetch({ url, signal: new AbortController().signal, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      status: "rejected",
      message: expect.stringContaining("private/reserved/local"),
    });
    expect(sent).toBe(false);
  });

  it.each([
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "http://localhost/",
    "https://example.com:8443/",
    "http://127.0.0.1/",
    "https://[::1]/",
  ])("rejects dangerous URL %s", async (url) => {
    const fetcher = createSafeWebFetchPort({
      resolver: {
        async resolve() {
          throw new Error("must not resolve");
        },
      },
      transport: {
        async get() {
          throw new Error("must not connect");
        },
      },
    });
    await expect(
      fetcher.fetch({ url, signal: new AbortController().signal, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      status: "rejected",
    });
  });

  it("rejects HTTPS downgrade, redirect loops, unsupported content and body limits deterministically", async () => {
    const resolver: WebAddressResolver = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const downgrade = createSafeWebFetchPort({
      resolver,
      transport: {
        async get() {
          return {
            status: 302,
            headers: { location: "http://public.example/" },
            body: await bytes(""),
          };
        },
      },
    });
    await expect(
      downgrade.fetch({
        url: "https://public.example/",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      message: expect.stringContaining("downgrade"),
    });

    const loop = createSafeWebFetchPort({
      resolver,
      transport: {
        async get() {
          return {
            status: 302,
            headers: { location: "https://public.example/" },
            body: await bytes(""),
          };
        },
      },
    });
    await expect(
      loop.fetch({
        url: "https://public.example/",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "rejected", message: expect.stringContaining("loop") });

    const unsupported = createSafeWebFetchPort({
      resolver,
      transport: {
        async get() {
          return {
            status: 200,
            headers: { "content-type": "image/png" },
            body: await bytes("png"),
          };
        },
      },
    });
    await expect(
      unsupported.fetch({
        url: "https://public.example/",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "rejected" });

    const limited = createSafeWebFetchPort({
      resolver,
      limits: { maximumBodyBytes: 3 },
      transport: {
        async get() {
          return {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: await bytes("four"),
          };
        },
      },
    });
    await expect(
      limited.fetch({
        url: "https://public.example/",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "output_limit" });
  });

  it("maps web_fetch and web_search timeout/abort without leaking credentials", async () => {
    const resolver: WebAddressResolver = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const waitingTransport: PinnedHttpTransport = {
      async get(request) {
        if (request.signal.aborted) throw request.signal.reason;
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    };
    const fetcher = createSafeWebFetchPort({ resolver, transport: waitingTransport });
    await expect(
      fetcher.fetch({
        url: "https://public.example/",
        signal: new AbortController().signal,
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({ status: "timed_out" });
    const fetchAbort = new AbortController();
    fetchAbort.abort();
    await expect(
      fetcher.fetch({
        url: "https://public.example/",
        signal: fetchAbort.signal,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    const secret = "search-timeout-secret";
    const search = createBraveWebSearchProvider({
      credentials: createCredentialResolver([
        {
          id: "fixture",
          async resolve() {
            return {
              status: "found",
              credential: { kind: "api_key", value: new SecretString(secret) },
              sourceId: "fixture",
            };
          },
        },
      ]),
      transport: {
        async send(request) {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
          });
          throw new Error(secret);
        },
      },
    });
    const searchResult = await search.search(
      { query: "query", maximumResults: 1 },
      { signal: new AbortController().signal, timeoutMs: 5 },
    );
    expect(searchResult).toMatchObject({ status: "timed_out" });
    expect(JSON.stringify(searchResult)).not.toContain(secret);
  });

  it("web_search and web_fetch pass through one ToolHost plan and produce exactly one redacted ToolOutcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-web-tools-"));
    temporaryDirectories.push(root);
    const credential = "brave-fixture-secret";
    const search = createBraveWebSearchProvider({
      credentials: createCredentialResolver([
        {
          id: "fixture",
          async resolve() {
            return {
              status: "found",
              credential: { kind: "api_key", value: new SecretString(credential) },
              sourceId: "fixture",
            };
          },
        },
      ]),
      transport: {
        async send(request) {
          expect(request.url).toContain("q=canonical+contracts");
          expect(request.headers["x-subscription-token"]).toBe(credential);
          return {
            status: 200,
            async json() {
              return {
                web: {
                  results: [
                    { title: "One", url: "https://example.com/one", description: credential },
                    { title: "Two", url: "https://example.com/two", description: "second" },
                  ],
                },
              };
            },
          };
        },
      },
    });
    const host = createCodingToolHost({
      workspaceRoot: root,
      webSearchProvider: search,
      webFetch: {
        async fetch() {
          return {
            status: "succeeded",
            finalUrl: "https://example.com/",
            httpStatus: 200,
            contentType: "text/plain",
            text: credential,
            redirects: 0,
            bodyBytes: credential.length,
          };
        },
      },
      registeredSecrets: () => [credential],
    });
    const searchOutcome = await host.execute(
      {
        type: "tool_call",
        callId: "search",
        name: "web_search",
        arguments: { query: "canonical contracts", maxResults: 2 },
      },
      { runId: runId("web-run"), signal: new AbortController().signal },
    ).outcome;
    expect(searchOutcome).toMatchObject({
      status: "succeeded",
      effectState: "none",
      artifacts: [],
    });
    expect(searchOutcome.modelContent).toContain("[REDACTED]");
    expect(searchOutcome.modelContent).not.toContain(credential);

    const fetchOutcome = await host.execute(
      {
        type: "tool_call",
        callId: "fetch",
        name: "web_fetch",
        arguments: { url: "https://example.com/" },
      },
      { runId: runId("web-run"), signal: new AbortController().signal },
    ).outcome;
    expect(fetchOutcome).toMatchObject({ status: "succeeded", effectState: "none", artifacts: [] });
    expect(fetchOutcome.modelContent).toContain("[REDACTED]");
    await host[Symbol.asyncDispose]();
  });
});
