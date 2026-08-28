declare const runIdBrand: unique symbol;
declare const sessionIdBrand: unique symbol;
declare const branchIdBrand: unique symbol;
declare const recordIdBrand: unique symbol;

export type RunId = string & { readonly [runIdBrand]: true };
export type SessionId = string & { readonly [sessionIdBrand]: true };
export type BranchId = string & { readonly [branchIdBrand]: true };
export type RecordId = string & { readonly [recordIdBrand]: true };

function branded<T extends string>(value: string, name: string): T {
  if (value.trim().length === 0) throw new TypeError(`${name} 不能为空`);
  return value as T;
}

export const runId = (value: string): RunId => branded<RunId>(value, "RunId");
export const sessionId = (value: string): SessionId => branded<SessionId>(value, "SessionId");
export const branchId = (value: string): BranchId => branded<BranchId>(value, "BranchId");
export const recordId = (value: string): RecordId => branded<RecordId>(value, "RecordId");

export interface Clock {
  now(): number;
}

export interface IdFactory {
  next(scope: "session" | "branch" | "run" | "record" | "manifest"): string;
}
