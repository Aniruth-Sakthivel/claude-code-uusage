import { describe, expect, it } from "vitest";

import { __unsafeCreateRequestContext, hasEmptyScope, isExternalContext } from "./index.js";
import { CAPABILITIES, ROLES, canGrantRole, capabilitiesFor, roleHas, seesAllProjects } from "./rbac.js";

describe("capability matrix", () => {
  it("gives admin every capability", () => {
    for (const capability of CAPABILITIES) {
      expect(roleHas("admin", capability)).toBe(true);
    }
  });

  it("gives client exactly one capability", () => {
    expect([...capabilitiesFor("client")]).toEqual(["comment"]);
  });

  it("never lets a non-admin manage the workspace", () => {
    for (const role of ROLES) {
      if (role === "admin") continue;
      expect(roleHas(role, "manage_workspace")).toBe(false);
    }
  });

  it("never lets an external role see all projects", () => {
    expect(seesAllProjects("client")).toBe(false);
  });

  it("keeps view_audit to admin alone", () => {
    const holders = ROLES.filter((r) => roleHas(r, "view_audit"));
    expect(holders).toEqual(["admin"]);
  });
});

describe("canGrantRole", () => {
  it("lets admin grant anything", () => {
    for (const role of ROLES) expect(canGrantRole("admin", role)).toBe(true);
  });

  it("stops a manager granting admin — the one-step escalation", () => {
    expect(canGrantRole("manager", "admin")).toBe(false);
  });

  it("stops a contributor granting a lead", () => {
    expect(canGrantRole("contributor", "lead")).toBe(false);
  });

  it("lets a role grant its own role", () => {
    for (const role of ROLES) expect(canGrantRole(role, role)).toBe(true);
  });

  it("is not accidentally symmetric", () => {
    expect(canGrantRole("manager", "contributor")).toBe(true);
    expect(canGrantRole("contributor", "manager")).toBe(false);
  });
});

describe("RequestContext", () => {
  it("nulls the project scope for a role that sees everything", () => {
    const ctx = __unsafeCreateRequestContext({
      userId: "u1",
      role: "manager",
      workspaceId: "w1",
      projectIds: ["ignored"],
    });
    expect(ctx.projectScope).toBeNull();
    expect(hasEmptyScope(ctx)).toBe(false);
  });

  it("keeps an empty scope empty — it must never widen to null", () => {
    const ctx = __unsafeCreateRequestContext({
      userId: "u1",
      role: "contributor",
      workspaceId: "w1",
      projectIds: [],
    });
    // This is the assertion the whole tenancy design rests on. If an empty
    // grant list ever becomes `null`, every scoped query returns the entire
    // workspace instead of nothing.
    expect(ctx.projectScope).toEqual([]);
    expect(ctx.projectScope).not.toBeNull();
    expect(hasEmptyScope(ctx)).toBe(true);
  });

  it("carries explicit grants through unchanged", () => {
    const ctx = __unsafeCreateRequestContext({
      userId: "u1",
      role: "contributor",
      workspaceId: "w1",
      projectIds: ["p1", "p2"],
    });
    expect(ctx.projectScope).toEqual(["p1", "p2"]);
  });

  it("copies the grant list, so a later mutation of the input cannot widen scope", () => {
    const projectIds = ["p1"];
    const ctx = __unsafeCreateRequestContext({
      userId: "u1",
      role: "contributor",
      workspaceId: "w1",
      projectIds,
    });
    (projectIds as string[]).push("p2");
    expect(ctx.projectScope).toEqual(["p1"]);
  });

  it("flags an external principal", () => {
    const ctx = __unsafeCreateRequestContext({
      userId: "u1",
      role: "client",
      workspaceId: "w1",
      projectIds: ["p1"],
    });
    expect(isExternalContext(ctx)).toBe(true);
    expect(ctx.projectScope).toEqual(["p1"]);
  });
});
