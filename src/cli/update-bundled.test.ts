import { describe, expect, test } from "bun:test";
import { isBundledBuild } from "./update";

describe("a carafe bundled in Carafe.app", () => {
  test("is recognised by its build target and never self-updates", () => {
    expect(isBundledBuild("darwin-arm64-app")).toBe(true);
    expect(isBundledBuild("darwin-x64-app")).toBe(true);
    expect(isBundledBuild("darwin-arm64")).toBe(false);
    expect(isBundledBuild("source")).toBe(false);
  });
});
