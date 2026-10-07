/**
 * Basic redaction pass — high-precision secret patterns only. Used in the
 * silent same-machine handoff (Priority 2). The full engine (gitleaks corpus +
 * entropy + structural + policy + HMAC placeholders) extends this at the
 * cross-person egress gate (task 3).
 */
export const RULES: Array<[string, RegExp]> = [
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai-key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g],
  ["stripe-key", /\bsk_live_[A-Za-z0-9]{10,}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["conn-string", /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@/]+:([^\s@/]+)@/g],
];

export interface RedactResult { text: string; hits: Record<string, number> }

export function redactText(input: string): RedactResult {
  let text = input;
  const hits: Record<string, number> = {};
  for (const [name, re] of RULES) {
    text = text.replace(re, (match, capturedPw?: string) => {
      hits[name] = (hits[name] ?? 0) + 1;
      // conn-string: mask only the password, keep the shape readable. The match
      // ends `:pw@` — slice positionally; replace() would hit the FIRST
      // occurrence and mask the username when user === pass.
      if (name === "conn-string" && capturedPw)
        return match.slice(0, match.length - 1 - capturedPw.length) + `⟦REDACTED:pw⟧@`;
      return `⟦REDACTED:${name}⟧`;
    });
  }
  return { text, hits };
}

export const mergeHits = (into: Record<string, number>, from: Record<string, number>): void => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};
