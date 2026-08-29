import type { RunId } from "@coding-agent/agent";
import type { ApprovalPort, ApprovalRequest, ApprovalResponse } from "../tools/coding-tool-host.js";

export interface ApprovalResponseCommand {
  readonly approvalId: string;
  readonly runId: RunId;
  readonly decision: "allow_once" | "deny";
  readonly planFingerprint: string;
}

export interface ApprovalResponseAck {
  readonly approvalId: string;
  readonly status: "accepted" | "already_applied" | "unknown" | "stale";
}

export type ApprovalLifecycleEvent =
  | { readonly type: "requested"; readonly request: ApprovalRequest }
  | {
      readonly type: "resolved";
      readonly request: ApprovalRequest;
      readonly decision: "allow_once" | "deny";
    }
  | { readonly type: "stale" | "withdrawn"; readonly request: ApprovalRequest };

export interface ApprovalBridge extends ApprovalPort {
  requests(): AsyncIterable<ApprovalRequest>;
  subscribe(listener: (request: ApprovalRequest) => void): () => void;
  subscribeLifecycle(listener: (event: ApprovalLifecycleEvent) => void): () => void;
  diagnostics(): { readonly listenerFailureCount: number };
  respond(command: ApprovalResponseCommand): ApprovalResponseAck;
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly signal: AbortSignal;
  readonly resolve: (response: ApprovalResponse) => void;
  readonly abort: () => void;
}

class ApprovalRequestStream {
  readonly #items: ApprovalRequest[] = [];
  readonly #waiters = new Set<() => void>();

  publish(request: ApprovalRequest): void {
    this.#items.push(request);
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async *events(): AsyncIterable<ApprovalRequest> {
    let index = 0;
    while (true) {
      while (index < this.#items.length) {
        const item = this.#items[index];
        index += 1;
        if (item) yield item;
      }
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }
}

export function createApprovalBridge(): ApprovalBridge {
  const stream = new ApprovalRequestStream();
  const pending = new Map<string, PendingApproval>();
  const applied = new Map<string, ApprovalRequest>();
  const stale = new Map<string, ApprovalRequest>();
  const listeners = new Set<(request: ApprovalRequest) => void>();
  const lifecycleListeners = new Set<(event: ApprovalLifecycleEvent) => void>();
  let listenerFailureCount = 0;
  const publishLifecycle = (event: ApprovalLifecycleEvent): void => {
    for (const listener of lifecycleListeners) {
      try {
        listener(event);
      } catch (_error) {
        listenerFailureCount += 1;
      }
    }
  };
  return {
    request(request, signal) {
      if (signal.aborted) {
        return Promise.reject(new DOMException("Approval 已取消", "AbortError"));
      }
      if (pending.has(request.approvalId) || applied.has(request.approvalId)) {
        return Promise.reject(new Error("duplicate approvalId"));
      }
      return new Promise<ApprovalResponse>((resolve, reject) => {
        const abort = () => {
          pending.delete(request.approvalId);
          publishLifecycle({ type: "withdrawn", request });
          reject(new DOMException("Approval 已取消", "AbortError"));
        };
        pending.set(request.approvalId, { request, signal, resolve, abort });
        signal.addEventListener("abort", abort, { once: true });
        stream.publish(request);
        publishLifecycle({ type: "requested", request });
        for (const listener of listeners) {
          try {
            listener(request);
          } catch (_error) {
            listenerFailureCount += 1;
          }
        }
      });
    },
    requests: () => stream.events(),
    diagnostics: () => ({ listenerFailureCount }),
    subscribe(listener) {
      listeners.add(listener);
      for (const waiting of pending.values()) {
        try {
          listener(waiting.request);
        } catch (_error) {
          listenerFailureCount += 1;
        }
      }
      return () => listeners.delete(listener);
    },
    subscribeLifecycle(listener) {
      lifecycleListeners.add(listener);
      for (const waiting of pending.values()) {
        try {
          listener({ type: "requested", request: waiting.request });
        } catch (_error) {
          listenerFailureCount += 1;
        }
      }
      return () => lifecycleListeners.delete(listener);
    },
    invalidate(approvalId) {
      const request = applied.get(approvalId) ?? pending.get(approvalId)?.request;
      applied.delete(approvalId);
      if (request) {
        stale.set(approvalId, request);
        publishLifecycle({ type: "stale", request });
      }
    },
    respond(command) {
      if (stale.has(command.approvalId)) {
        return { approvalId: command.approvalId, status: "stale" };
      }
      if (applied.has(command.approvalId)) {
        return { approvalId: command.approvalId, status: "already_applied" };
      }
      const waiting = pending.get(command.approvalId);
      if (!waiting || waiting.request.runId !== command.runId) {
        return { approvalId: command.approvalId, status: "unknown" };
      }
      if (waiting.request.plan.fingerprint !== command.planFingerprint) {
        return { approvalId: command.approvalId, status: "stale" };
      }
      pending.delete(command.approvalId);
      applied.set(command.approvalId, waiting.request);
      waiting.signal.removeEventListener("abort", waiting.abort);
      waiting.resolve({
        decision: command.decision,
        planFingerprint: command.planFingerprint,
      });
      publishLifecycle({ type: "resolved", request: waiting.request, decision: command.decision });
      return { approvalId: command.approvalId, status: "accepted" };
    },
  };
}
