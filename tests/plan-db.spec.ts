// Bun-only test for the plan-store SQLite layer (db.ts uses bun:sqlite). This
// is intentionally NOT part of the node `just test` suite (the core must load
// without Bun), so it is named *.bun-test.ts and run with `bun test` when the
// dashboard/DB layer changes:  bun test tests/plan-db.bun-test.ts
import { expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway file BEFORE importing db.ts (it opens DB_PATH at
// module load). config.ts reads HIVE_TELEMETRY_DB.
process.env.HIVE_TELEMETRY_DB = join(mkdtempSync(join(tmpdir(), "pi-hive-plandb-")), "telemetry.db");

let db: typeof import("../src/observability/server/db");

beforeAll(async () => {
  db = await import("../src/observability/server/db");
});

test("plan_verdicts persists red/yellow/green and latestVerdict returns the newest", () => {
  db.insertPlanVerdict({ id: "v1", changeId: "c1", reviewer: "Rev", verdict: "yellow", summary: "notes", concerns: ["x"], createdAt: "2026-07-01T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "v2", changeId: "c1", reviewer: "Rev", verdict: "green", summary: "clean", evidence: ["ran tests"], createdAt: "2026-07-01T11:00:00.000Z" });
  db.insertPlanVerdict({ id: "v3", changeId: "c2", reviewer: "Rev", verdict: "red", summary: "blocked", blockers: ["authz"], createdAt: "2026-07-01T10:30:00.000Z" });

  const all = db.listVerdicts("c1");
  expect(all.length).toBe(2);
  expect(all[0].verdict).toBe("yellow");
  expect(all[0].concerns).toEqual(["x"]);

  const latest = db.latestVerdict("c1");
  expect(latest?.verdict).toBe("green");
  expect(latest?.evidence).toEqual(["ran tests"]);

  const c2 = db.latestVerdict("c2");
  expect(c2?.verdict).toBe("red");
  expect(c2?.blockers).toEqual(["authz"]);
});

test("latestVerdictExcludingHumanGreen skips human 'ui' green verdicts; later automated verdicts still surface", () => {
  // The row-pill filter (see plan-routes.ts:listPlans). When a human approves
  // green via the dashboard, the row pill should hide the older automated
  // concerns — but a LATER automated yellow/red (re-review after approval)
  // must still come through, because ORDER BY created_at DESC + the filter
  // combine to skip only verdicts that are themselves (ui, green).

  // Case 1: only automated verdicts — pill surfaces latest.
  db.insertPlanVerdict({ id: "n1", changeId: "no-human", reviewer: "Plan Reviewer", verdict: "yellow", summary: "concerns", createdAt: "2026-08-01T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "n2", changeId: "no-human", reviewer: "Plan Reviewer", verdict: "red", summary: "blocking", createdAt: "2026-08-01T11:00:00.000Z" });
  expect(db.latestVerdictExcludingHumanGreen("no-human")?.verdict).toBe("red");
  expect(db.latestVerdictExcludingHumanGreen("no-human")?.summary).toBe("blocking");

  // Case 2: automated yellow then human green — pill hides entirely.
  db.insertPlanVerdict({ id: "h1", changeId: "human-approved", reviewer: "Plan Reviewer", verdict: "yellow", summary: "old concern", createdAt: "2026-08-02T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "h2", changeId: "human-approved", reviewer: "ui", verdict: "green", summary: "looks good", createdAt: "2026-08-02T11:00:00.000Z" });
  expect(db.latestVerdictExcludingHumanGreen("human-approved")).toBeNull();

  // Case 3: human green, then LATER automated yellow re-review — pill surfaces yellow.
  db.insertPlanVerdict({ id: "h3", changeId: "human-then-auto", reviewer: "ui", verdict: "green", summary: "first approval", createdAt: "2026-08-03T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "h4", changeId: "human-then-auto", reviewer: "Plan Reviewer", verdict: "yellow", summary: "post-approval concern", createdAt: "2026-08-03T11:00:00.000Z" });
  expect(db.latestVerdictExcludingHumanGreen("human-then-auto")?.verdict).toBe("yellow");
  expect(db.latestVerdictExcludingHumanGreen("human-then-auto")?.summary).toBe("post-approval concern");

  // Case 4: raw latestVerdict is unchanged (still surfaces the latest row
  // regardless of reviewer — used elsewhere; the row pill is the only caller
  // that wants the filtered view).
  expect(db.latestVerdict("human-approved")?.verdict).toBe("green");
  expect(db.latestVerdict("human-then-auto")?.verdict).toBe("yellow");
});

test("insertPlanVerdict is idempotent on the same id (replay-safe)", () => {
  db.insertPlanVerdict({ id: "dup", changeId: "c3", reviewer: "Rev", verdict: "green", summary: "one", createdAt: "2026-07-01T10:00:00.000Z" });
  db.insertPlanVerdict({ id: "dup", changeId: "c3", reviewer: "Rev", verdict: "red", summary: "two", createdAt: "2026-07-01T10:00:00.000Z" });
  const all = db.listVerdicts("c3");
  expect(all.length).toBe(1);
  expect(all[0].verdict).toBe("green"); // first write wins (INSERT OR IGNORE)
});

test("plan_approvals and plan_comments round-trip", () => {
  db.insertPlanApproval({ id: "a1", changeId: "c1", phase: "proposal", approvedBy: "ui", actor: "tester", createdAt: "2026-07-01T12:00:00.000Z" });
  db.insertPlanApproval({ id: "a2", changeId: "c1", phase: "design", approvedBy: "chat", createdAt: "2026-07-01T13:00:00.000Z" });
  const approvals = db.listApprovals("c1");
  expect(approvals.length).toBe(2);
  expect(approvals[0].phase).toBe("proposal");
  expect(approvals[1].approvedBy).toBe("chat");

  db.insertPlanComment({ id: "cm1", changeId: "c1", file: "design.md", anchor: "risks", author: "tester", body: "reconsider retries", createdAt: "2026-07-01T14:00:00.000Z" });
  const comments = db.listComments("c1");
  expect(comments.length).toBe(1);
  expect(comments[0].file).toBe("design.md");
  expect(comments[0].body).toBe("reconsider retries");
});
