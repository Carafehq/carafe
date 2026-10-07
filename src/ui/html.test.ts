import { describe, expect, test } from "bun:test";
import { HTML } from "./html";

// The whole frontend is one template literal, so a backslash meant for the
// browser (a regex escape like \/ or \d) must be written as \\ in the source
// or it is consumed by the template. A single missed escape throws at load and
// blanks the entire app. Parsing the served script catches that class of bug.
describe("ui html", () => {
  test("every inline script parses as JavaScript", () => {
    const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const [index, body] of scripts.entries()) {
      expect(() => new Function(body), `inline script #${index + 1}`).not.toThrow();
    }
  });
});
