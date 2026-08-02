/**
 * The write-scope gate and the pagination envelope — the two pieces of api-core that are
 * pure logic and must not regress.
 *
 * The scope test is the important one: before this existed, `write: true` was declared on
 * ops and checked by nobody, so any API key could untrack every keyword in the workspace.
 */
import { describe, it, expect } from "vitest";
import { OPS, runOp, ApiError } from "./api-core";

const READ = { scope: "read" as const };
const WRITE = { scope: "write" as const };

/** Every op that mutates workspace data. If a new one is added, it must be marked. */
const WRITE_OPS = Object.entries(OPS).filter(([, op]) => op.write).map(([name]) => name);
const READ_OPS = Object.entries(OPS).filter(([, op]) => !op.write).map(([name]) => name);

describe("runOp scope enforcement", () => {
  it("refuses every write op for a read-only key", async () => {
    expect(WRITE_OPS.length).toBeGreaterThan(5); // guard against the list silently emptying
    for (const name of WRITE_OPS) {
      await expect(runOp(name, {}, READ)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    }
  });

  // The allow paths are exercised against a probe op rather than the real registry: running
  // a real op here would either hit the network or, with DATABASE_URL set, actually mutate
  // Brandon's workspace. A test must never be one env var away from deleting live data.
  it("runs a write op for a write key", async () => {
    OPS.__probe_write = { description: "probe op used only by the test suite", schema: { type: "object", properties: {} }, write: true, run: async () => "ran" };
    try {
      await expect(runOp("__probe_write", {}, WRITE)).resolves.toBe("ran");
      await expect(runOp("__probe_write", {}, READ)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      delete OPS.__probe_write;
    }
  });

  it("runs a read op for a read key", async () => {
    OPS.__probe_read = { description: "probe op used only by the test suite", schema: { type: "object", properties: {} }, run: async () => "ran" };
    try {
      await expect(runOp("__probe_read", {}, READ)).resolves.toBe("ran");
    } finally {
      delete OPS.__probe_read;
    }
  });

  it("leaves read ops unmarked so the gate lets them through", () => {
    expect(READ_OPS.length).toBeGreaterThan(15);
    for (const name of READ_OPS) expect(OPS[name].write).toBeFalsy();
  });

  it("404s an unknown op instead of running anything", async () => {
    await expect(runOp("definitely_not_an_op", {}, WRITE)).rejects.toBeInstanceOf(ApiError);
    await expect(runOp("definitely_not_an_op", {}, WRITE)).rejects.toMatchObject({ status: 404 });
  });

  it("marks the destructive ops as writes", () => {
    // Spot-check the ones that would hurt most if they were ever readable.
    for (const name of ["untrack_app", "untrack_keywords", "track_keywords", "add_competitor", "set_alert_rule"]) {
      expect(OPS[name], `${name} is missing from the registry`).toBeDefined();
      expect(OPS[name].write, `${name} must be marked write: true`).toBe(true);
    }
  });
});

describe("tool registry", () => {
  it("gives every op a description and an object schema (both are the MCP contract)", () => {
    for (const [name, op] of Object.entries(OPS)) {
      expect(op.description.length, `${name} needs a description`).toBeGreaterThan(20);
      expect(op.schema.type, `${name} schema must be an object`).toBe("object");
    }
  });
});
