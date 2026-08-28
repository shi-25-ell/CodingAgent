import type {
  AnthropicTransport,
  AnthropicTransportRequest,
  AnthropicTransportResponse,
} from "./contracts.js";

async function* decodeBody(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

export function createFetchAnthropicTransport(): AnthropicTransport {
  return {
    async send(request: AnthropicTransportRequest): Promise<AnthropicTransportResponse> {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: decodeBody(response.body) };
    },
  };
}
