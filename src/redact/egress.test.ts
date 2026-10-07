import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { egressScrub } from "./egress";

const temps: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "carafe-egress-"));
  temps.push(dir);
  return dir;
}

/** Fake secrets are assembled at run time so the source never holds a key-shaped literal
 * (hosting providers' secret scanners block pushes that contain one). */
const fake = (...parts: string[]): string => parts.join("");

function reportText(result: ReturnType<typeof egressScrub>): string {
  return JSON.stringify(result.report);
}

describe("egress format detectors", () => {
  const cases: Array<{ name: string; kind: string; text: string; absent: string }> = [
    { name: "AWS access key id", kind: "aws-key", text: "key AKIA1234567890ABCDEF here", absent: "AKIA1234567890ABCDEF" },
    { name: "GitHub classic token", kind: "github-token", text: "token ghp_abcdefghijklmnopqrstuvwxyz", absent: "ghp_abcdefghijklmnopqrstuvwxyz" },
    { name: "Stripe key", kind: "stripe-key", text: "stripe " + fake("sk_live_", "abcdefghijklmnopqrstuvwxyz"), absent: fake("sk_live_", "abcdefghijklmnopqrstuvwxyz") },
    { name: "Slack token", kind: "slack-token", text: "slack xoxb-abc-def-ghi-jkl-mno-pqr", absent: "xoxb-abc-def-ghi-jkl-mno-pqr" },
    { name: "SendGrid key", kind: "sendgrid-key", text: "sendgrid SG.abcdefghijklmnop.qrstuvwxyzABCDEF", absent: "SG.abcdefghijklmnop.qrstuvwxyzABCDEF" },
    { name: "JWT", kind: "jwt", text: "jwt eyJabcdefghijkl.eyJmnopqrstuv.wxYz123456", absent: "eyJabcdefghijkl.eyJmnopqrstuv.wxYz123456" },
    { name: "private key", kind: "private-key", text: "pem -----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY----- done", absent: "abcdef" },
    { name: "DB connection string password", kind: "conn-string", text: "db postgres://user:passw0rdSECRET@localhost/db", absent: "passw0rdSECRET" },
    { name: "Anthropic key", kind: "anthropic-key", text: "anthropic sk-ant-abcdefghijklmnopqrstuvwxyz123456", absent: "sk-ant-abcdefghijklmnopqrstuvwxyz123456" },
    { name: "OpenAI key", kind: "openai-key", text: "openai sk-abcdefghijklmnopqrstuvwxyz123456", absent: "sk-abcdefghijklmnopqrstuvwxyz123456" },
    { name: "GitHub fine-grained token", kind: "github-token", text: "fine github_pat_abcdefghijklmnopqrstuvwxyz_1234567890", absent: "github_pat_abcdefghijklmnopqrstuvwxyz_1234567890" },
    { name: "AWS secret access key", kind: "aws-secret-access-key", text: "aws_secret_access_key = AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AB", absent: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AB" },
    { name: "Twilio AC token", kind: "twilio-token", text: "twilio " + fake("AC", "0123456789abcdef0123456789abcdef"), absent: fake("AC", "0123456789abcdef0123456789abcdef") },
    { name: "Twilio SK token", kind: "twilio-token", text: "twilio " + fake("SK", "0123456789abcdef0123456789abcdef"), absent: fake("SK", "0123456789abcdef0123456789abcdef") },
    { name: "generic assignment", kind: "assignment-secret", text: "api_key = genericSecretValue12345", absent: "genericSecretValue12345" },
    { name: "bearer token", kind: "bearer-token", text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", absent: "abcdefghijklmnopqrstuvwxyz123456" },
    { name: "HTTP basic auth URL", kind: "basic-auth-url", text: "url https://alice:correct-horse-battery@example.com/a", absent: "correct-horse-battery" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = egressScrub(c.text, { cwd: null });
      expect(result.report.findings.some((f) => f.kind === c.kind && f.action === "redacted")).toBe(true);
      expect(result.text).toContain(`⟦EGRESS:${c.kind}⟧`);
      expect(result.text).not.toContain(c.absent);
      expect(reportText(result)).not.toContain(c.absent);
    });
  }
});

describe("egress entropy detectors", () => {
  test("flags a random 32-char base64-like secret as borderline and masks it", () => {
    const secret = "A7f9Kq2LmN8pR4sT6vWxYz3BcD5eGhJk";
    const result = egressScrub(`candidate ${secret} done`, { cwd: null });
    expect(result.report.borderlineCount).toBe(1);
    expect(result.report.findings).toEqual([{ kind: "entropy", action: "borderline", count: 1, samples: [`candidate ⟦EGRESS:entropy⟧ done`] }]);
    expect(result.text).not.toContain(secret);
  });

  const guards = [
    ["UUID", "550e8400-e29b-41d4-a716-446655440000"],
    ["40-char pure hex", "0123456789abcdef0123456789abcdef01234567"],
    ["64-char pure hex", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
    ["pure decimal run", "1234567890123456789012345678901234567890"],
    ["file path", "src/redact/egress.test.ts"],
    ["rooted file path", "/Users/alice/project/src/redact/egress.test.ts"],
    ["data URI", "data:image/png;base64,A7f9Kq2LmN8pR4sT6vWxYz3BcD5eGhJk"],
    ["ISO timestamp", "2026-07-05T12:34:56.789Z"],
    ["domain name", "averylongsubdomain.example.com"],
    ["URL without credentials", "https://averylongsubdomain.example.com/path/to/file"],
    ["ordinary English prose", "this is ordinary prose with many harmless words and no secret token"],
    ["ordinary English word", "characteristicallyunexceptional"],
  ] as const;

  for (const [name, text] of guards) {
    test(`does not flag ${name}`, () => {
      const result = egressScrub(text, { cwd: null });
      expect(result.report.findings).toEqual([]);
      expect(result.text).toBe(text);
    });
  }
});

describe("egress env matching", () => {
  test("matches env values from cwd/home chain without surfacing the value", () => {
    const home = tempDir();
    const cwd = join(home, "work", "repo");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;

    const secret = "super-secret-env-value-123!";
    const encoded = encodeURIComponent(secret);
    writeFileSync(join(home, ".env"), `export SERVICE_TOKEN="${secret}"\nDEBUG=true\nPORT=1234\n`);

    const result = egressScrub(`plain ${secret} encoded ${encoded}`, { cwd });
    const envFinding = result.report.findings.find((f) => f.kind === "env:SERVICE_TOKEN");
    expect(envFinding?.count).toBe(2);
    expect(result.text).toBe("plain ⟦EGRESS:env:SERVICE_TOKEN⟧ encoded ⟦EGRESS:env:SERVICE_TOKEN⟧");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(encoded);
  });
});

describe("egress precedence and determinism", () => {
  test("format findings suppress overlapping entropy findings", () => {
    const token = "github_pat_A7f9Kq2LmN8pR4sT6vWxYz3BcD5eGhJk_1234567890";
    const result = egressScrub(`token ${token}`, { cwd: null });
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]!.kind).toBe("github-token");
    expect(result.report.findings[0]!.action).toBe("redacted");
    expect(result.report.borderlineCount).toBe(0);
  });

  test("same input produces identical output and report", () => {
    const fixture = [
      "api_key=genericSecretValue12345",
      "candidate A7f9Kq2LmN8pR4sT6vWxYz3BcD5eGhJk",
      "url https://alice:correct-horse-battery@example.com/a",
    ].join("\n");
    const a = egressScrub(fixture, { cwd: null });
    const b = egressScrub(fixture, { cwd: null });
    expect(b).toEqual(a);
  });
});

describe("review-round regressions", () => {
  test("basic-auth URL with user === pass masks the PASSWORD, not the username", () => {
    const r = egressScrub("url https://admin:admin@example.com/db", { cwd: null });
    expect(r.text).toBe("url https://admin:⟦EGRESS:basic-auth-url⟧@example.com/db");
  });

  test("conn-string with user === pass masks the password position", () => {
    const r = egressScrub("db postgres://admin:admin@localhost/db", { cwd: null });
    expect(r.text).toBe("db postgres://admin:⟦EGRESS:conn-string⟧@localhost/db");
  });

  test("env value containing slashes is matched (path heuristic must not skip it)", () => {
    const home = tempDir();
    const cwd = join(home, "repo");
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
    writeFileSync(join(home, ".env"), "PASS_PHRASE=my/secret/passphrase123\nAWS_SECRET=AbCd/EfGh+IjKl/MnOpQrStUvWxYz012345678\n");

    const r = egressScrub("a my/secret/passphrase123 b AbCd/EfGh+IjKl/MnOpQrStUvWxYz012345678 c", { cwd });
    expect(r.text).toBe("a ⟦EGRESS:env:PASS_PHRASE⟧ b ⟦EGRESS:env:AWS_SECRET⟧ c");
    // env match must WIN over entropy for the base64-ish value (named > borderline)
    expect(r.report.findings.every((f) => f.kind !== "entropy")).toBe(true);
  });

  test("code shapes after secret-ish keys are NOT masked", () => {
    const code = [
      "const token = jwt.sign(payload, opts);",
      "password: hashPassword(input),",
      "secret = getSecretFromEnv(config)",
      "authorization: config.headers.authorization",
    ].join("\n");
    const r = egressScrub(code, { cwd: null });
    expect(r.report.findings.filter((f) => f.kind === "assignment-secret")).toEqual([]);
    expect(r.text).toBe(code);
  });

  test("real secret values after secret-ish keys ARE still masked", () => {
    const r = egressScrub("password = correct-horse-battery-staple9\napi_key: genericSecretValue12345", { cwd: null });
    const f = r.report.findings.find((x) => x.kind === "assignment-secret");
    expect(f?.count).toBe(2);
    expect(r.text).not.toContain("correct-horse-battery-staple9");
    expect(r.text).not.toContain("genericSecretValue12345");
  });
});

