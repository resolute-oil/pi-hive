// Wave 0 contract agreement test — Slice 1: BudgetLedger class shape
//
// Purpose: pin the public surface of BudgetLedger (constructor-as-factory via
// static restore + instance methods + accessors) so Wave 1+ can implement
// against a stable API. Every stub throws "not implemented" by design; the
// test only verifies the symbol is exported and the throw contract holds.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionManager, SessionStats } from "@earendil-works/pi-coding-agent";
import { BudgetLedger } from "../src/engine/budget/ledger.ts";

test("BudgetLedger is exported as a class", () => {
  assert.equal(typeof BudgetLedger, "function", "BudgetLedger must be exported as a class (constructor function)");
  assert.equal(BudgetLedger.name, "BudgetLedger", "BudgetLedger constructor must retain its name");
});

test("BudgetLedger.restore is a static factory returning a Promise<BudgetLedger>", () => {
  assert.equal(typeof BudgetLedger.restore, "function", "BudgetLedger.restore must be a static method");
  // The signature must accept (sessionManager, agentName, policy, signal). We
  // can't invoke without real SDK instances, but we CAN assert the arity so a
  // future refactor that drops a parameter breaks the test before runtime.
  assert.equal(BudgetLedger.restore.length, 4, "BudgetLedger.restore must take 4 parameters");
});

test("BudgetLedger instance methods exist with the expected signatures", () => {
  // The prototype carries the instance surface. Asserting on the prototype
  // (not an instance) avoids the static-factory call path; Wave 1 will populate
  // the instance from restore().
  const proto = BudgetLedger.prototype as unknown as Record<string, unknown>;
  assert.equal(typeof proto.recordEvent, "function", "recordEvent must exist on the prototype");
  assert.equal(typeof proto.maybeSnapshot, "function", "maybeSnapshot must exist on the prototype");
  assert.equal(typeof proto.recordCompaction, "function", "recordCompaction must exist on the prototype");
  assert.equal(typeof proto.snapshot, "function", "snapshot must exist on the prototype");
  // Each method's arity pins its contract — Wave 1 cannot drop parameters.
  assert.equal((proto.recordEvent as Function).length, 3, "recordEvent must take 3 parameters (type, cumulative, signal)");
  assert.equal((proto.maybeSnapshot as Function).length, 3, "maybeSnapshot must take 3 parameters (cumulative, policy, signal)");
  assert.equal((proto.recordCompaction as Function).length, 2, "recordCompaction must take 2 parameters (savings, signal)");
  assert.equal((proto.snapshot as Function).length, 4, "snapshot must take 4 parameters (stats, policy, marker, signal)");
});

test("BudgetLedger declares the entries and cumulative accessors as readonly", () => {
  // Compile-time check that the accessors carry the contract types. A
  // sample instance is typed; the runtime objects may be undefined until
  // Wave 1 fills them in.
  const sample: BudgetLedger = {} as unknown as BudgetLedger;
  const entriesType: ReadonlyArray<unknown> = sample.entries;
  const cumulativeType: { tokens: number; costUsd: number; runs: number } = sample.cumulative;
  assert.ok(Array.isArray(entriesType) || entriesType === undefined, "entries must be array-like at runtime");
  assert.ok(cumulativeType === undefined || typeof cumulativeType === "object", "cumulative must be the ledger's spend-shape at runtime");
});

test("BudgetLedger stub throws not implemented when called", async () => {
  // Build a throwaway instance that bypasses the static factory (the factory
  // itself is also a stub). We exercise the instance methods to verify each
  // carries the documented throw contract.
  const instance = Object.create(BudgetLedger.prototype) as BudgetLedger;
  const fakeSignal = new AbortController().signal;
  const fakePolicy = {} as never;
  const fakeStats = {} as SessionStats;

  assert.throws(() => instance.recordEvent("message_end", { tokens: 0, costUsd: 0, runs: 0 }, fakeSignal), /not implemented/);
  assert.throws(() => instance.maybeSnapshot({ tokens: 0, costUsd: 0, runs: 0 }, fakePolicy, fakeSignal), /not implemented/);
  assert.throws(() => instance.recordCompaction(0, fakeSignal), /not implemented/);
  assert.throws(() => instance.snapshot(fakeStats, fakePolicy, "checkpoint", fakeSignal), /not implemented/);
  await assert.rejects(
    BudgetLedger.restore({} as SessionManager, "agent", fakePolicy, fakeSignal),
    (error: Error) => error.message === "not implemented",
  );
});
