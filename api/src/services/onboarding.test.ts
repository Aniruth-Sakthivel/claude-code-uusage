/**
 * Regression tests for the generated one-line install command.
 *
 * The bug these lock down: `buildInstallCommand` embeds PowerShell variables
 * (`$s`) inside a double-quoted argument to an OUTER powershell.exe. Pasted
 * at a PowerShell prompt — the officially supported target — the outer shell
 * interpolates `$variables` in double-quoted strings even when the string is
 * only being built to hand to a nested `-Command`. An unescaped `$s` silently
 * becomes an empty string there, and the nested script receives nothing.
 * This was caught only by actually running the generated command in real
 * PowerShell, not by reading the code — a future edit that adds a variable
 * without backtick-escaping it would reintroduce exactly this, silently.
 */

import { describe, expect, it } from "vitest";

import { buildInstallCommand } from "./onboarding.js";

describe("buildInstallCommand", () => {
  const cmd = buildInstallCommand("https://meterhouse.example/api/v1/connect/script/tok123");

  it("backtick-escapes every PowerShell variable reference", () => {
    // Every `$s` must be preceded by a backtick — i.e. no bare, unescaped
    // dollar-sign variable reference anywhere in the string.
    const bareVariable = /(?<!`)\$[A-Za-z_]/;
    expect(cmd).not.toMatch(bareVariable);
    // And escaped ones are actually present — an empty match set here would
    // mean the whole repair logic silently vanished, not that it's safe.
    expect(cmd.match(/`\$s/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("captures the fetch into a variable rather than piping straight into iex", () => {
    // The direct-pipe form (`irm ... | iex`) is exactly what this replaces.
    expect(cmd).not.toMatch(/\|\s*iex/);
    expect(cmd).toContain("iex `$s");
  });

  it("repairs a line-split array response before executing it", () => {
    expect(cmd).toContain("-is [array]");
    expect(cmd).toContain("-join [Environment]::NewLine");
  });

  it("reports a plain error instead of a cryptic parameter-binding failure on empty input", () => {
    expect(cmd).toContain("IsNullOrWhiteSpace");
    expect(cmd).toContain("Could not fetch the setup script");
  });

  it("embeds the exact script URL with no extra encoding or mangling", () => {
    expect(cmd).toContain("https://meterhouse.example/api/v1/connect/script/tok123");
  });

  it("is a single powershell.exe -Command invocation, one line, no embedded newlines", () => {
    expect(cmd.startsWith("powershell -NoProfile -ExecutionPolicy Bypass -Command ")).toBe(true);
    expect(cmd).not.toMatch(/\r|\n/);
  });
});
