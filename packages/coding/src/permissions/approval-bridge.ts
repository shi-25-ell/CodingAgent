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

export interface ApprovalBridge extends ApprovalPort {
  requests(): AsyncIterable<ApprovalRequest>;
  subscribe(listener: (request: ApprovalRequest) => void): () => void;
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
  const applied = new Set<string>();
  const stale = new Set<string>();
  const listeners = new Set<(request: ApprovalRequest) => void>();
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
          reject(new DOMException("Approval 已取消", "AbortError"));
        };
        pending.set(request.approvalId, { request, signal, resolve, abort });
        signal.addEventListener("abort", abort, { once: true });
        stream.publish(request);
        for (const listener of listeners) listener(request);
      });
    },
    requests: () => stream.events(),
    subscribe(listener) {
      listeners.add(listener);
      for (const waiting of pending.values()) listener(waiting.request);
      return () => listeners.delete(listener);
    },
    invalidate(approvalId) {
      applied.delete(approvalId);
      stale.add(approvalId);
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
      applied.add(command.approvalId);
      waiting.signal.removeEventListener("abort", waiting.abort);
      waiting.resolve({
        decision: command.decision,
        planFingerprint: command.planFingerprint,
      });
      return { approvalId: command.approvalId, status: "accepted" };
    },
  };
}
