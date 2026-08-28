export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type WebSearchOutcome =
  | { readonly status: "succeeded"; readonly results: readonly WebSearchResult[] }
  | {
      readonly status: "not_configured" | "failed" | "timed_out" | "cancelled";
      readonly message: string;
    };

export interface WebSearchProvider {
  readonly id: string;
  search(
    input: { readonly query: string; readonly maximumResults: number },
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<WebSearchOutcome>;
}

export interface WebFetchRequest {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export type WebFetchOutcome =
  | {
      readonly status: "succeeded";
      readonly finalUrl: string;
      readonly httpStatus: number;
      readonly contentType: string;
      readonly text: string;
      readonly redirects: number;
      readonly bodyBytes: number;
    }
  | {
      readonly status: "rejected" | "failed" | "timed_out" | "cancelled" | "output_limit";
      readonly message: string;
    };

export interface WebFetchPort {
  fetch(request: WebFetchRequest): Promise<WebFetchOutcome>;
}
