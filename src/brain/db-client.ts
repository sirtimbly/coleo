/**
 * Brain-side DB contract.
 *
 * Runtime can be backed by API calls (preferred) or by a local sqlite handle in tests.
 */

export interface DbRunResult {
  changes: number;
  lastInsertRowid: number | bigint | null;
}

export interface DbQueryHandle {
  get: (...bindings: any[]) => unknown;
  all: (...bindings: any[]) => unknown[];
}

export interface BrainDb {
  run: (sql: string, ...bindings: any[]) => DbRunResult;
  query: (sql: string) => DbQueryHandle;
  transaction?: <T>(fn: () => T) => () => T;
  close?: () => void;
}
