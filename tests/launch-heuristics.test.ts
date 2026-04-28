import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitLaunchWarnings } from "../src/cli/launch-heuristics.js";

describe("emitLaunchWarnings", () => {
  it("warns when workers exceed 5", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        ...Array.from({ length: 6 }, (_, i) => ({ role: `Worker-${i}` })),
      ],
    });
    assert.ok(warnings.some((w) => w.includes("6 workers")));
    assert.ok(warnings.some((w) => w.includes("superlinearly")));
  });

  it("warns for single worker", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Worker" },
      ],
    });
    assert.ok(warnings.some((w) => w.includes("Single worker")));
  });

  it("warns for duplicate roles without specialization", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Backend" },
        { role: "Backend" },
      ],
    });
    assert.ok(warnings.some((w) => w.includes("2 workers share role")));
  });

  it("does not warn for duplicate roles with specialization", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Backend", specialization: "API" },
        { role: "Backend", specialization: "DB" },
      ],
    });
    assert.ok(!warnings.some((w) => w.includes("share role")));
  });

  it("warns when no verification is set with multiple workers", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Backend" },
        { role: "Frontend" },
      ],
    });
    assert.ok(warnings.some((w) => w.includes("No --verify")));
  });

  it("does not warn about verification when --verify is set", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Backend" },
        { role: "Frontend" },
      ],
      verify: "npm test",
    });
    assert.ok(!warnings.some((w) => w.includes("No --verify")));
  });

  it("does not warn about verification when --verifier is set", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Backend" },
        { role: "Frontend" },
      ],
      verifier: "QA",
    });
    assert.ok(!warnings.some((w) => w.includes("No --verify")));
  });

  it("warns for xhigh reasoning on 4+ workers", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        ...Array.from({ length: 4 }, (_, i) => ({ role: `W-${i}`, reasoningEffort: "xhigh" })),
      ],
    });
    assert.ok(warnings.some((w) => w.includes("xhigh reasoning")));
  });

  it("does not warn for xhigh on fewer than 4 workers", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "A", reasoningEffort: "xhigh" },
        { role: "B", reasoningEffort: "xhigh" },
        { role: "C", reasoningEffort: "xhigh" },
      ],
    });
    assert.ok(!warnings.some((w) => w.includes("xhigh reasoning")));
  });

  it("returns no warnings for a well-configured team", () => {
    const warnings = emitLaunchWarnings({
      team: [
        { role: "Lead", isLead: true },
        { role: "Backend", specialization: "API" },
        { role: "Frontend", specialization: "React" },
        { role: "Tests", specialization: "Integration" },
      ],
      verify: "npm test",
    });
    assert.equal(warnings.length, 0);
  });
});
