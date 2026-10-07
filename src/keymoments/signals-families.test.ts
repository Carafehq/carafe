import { describe, expect, test } from "bun:test";
import { commandFamily, commandOf } from "./signals";

describe("command families on real-shaped shell scripts", () => {
  test("multi-line scripts keep their lines as separators", () => {
    const line = `→ **Bash** ${JSON.stringify({ command: 'PS="/Users/x/product-search"\ncd "$PS"\necho "=== retry? ==="\ngrep -nE "retry|catch" stores/index.js' })}`;
    expect(commandOf(line)).toBe('PS="/Users/x/product-search" ; cd "$PS" ; echo "=== retry? ===" ; grep -nE "retry|catch" stores/index.js');
    expect(commandFamily(commandOf(line)!)).toBe("grep");
  });

  test("assignments, cd, and echo are never a family", () => {
    expect(commandFamily('cd "/a b" && bun test')).toBe("bun test");
    expect(commandFamily("FOO=1 BAR=x npx tsc --noEmit")).toBe("npx tsc");
    expect(commandFamily('PS="/x"; cd "$PS"; echo "hi"; pytest -q tests')).toBe("pytest");
    expect(commandFamily("export PATH=/opt/bin:$PATH && npm run build")).toBe("npm run build");
  });

  test("npm, bun, and yarn families retain script names", () => {
    expect(commandFamily("npm run deploy:develop")).toBe("npm run deploy:develop");
    expect(commandFamily("bun run lint")).toBe("bun run lint");
    expect(commandFamily("yarn build:ci")).toBe("yarn build:ci");
    expect(commandFamily("yarn run build:ci")).toBe("yarn run build:ci");
    expect(commandFamily("bun test src/queue.test.ts")).toBe("bun test");
  });

  test("a bare assignment or cd falls back to something sensible", () => {
    expect(commandFamily('cd "/Users/x/repo"')).toBe("cd");
    expect(commandFamily("git status --short")).toBe("git status");
  });
});
