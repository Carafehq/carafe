import { detectEntropy, detectEnvValues, detectFormat, type Detection, type EgressAction, type EnvSecret } from "./detectors";

export interface EgressFinding {
  kind: string;
  action: EgressAction;
  count: number;
  samples: string[];
}

export interface EgressReport {
  findings: EgressFinding[];
  totalRedactions: number;
  borderlineCount: number;
}

interface AppliedDetection extends Detection {
  outputStart?: number;
  outputEnd?: number;
}

function overlaps(a: Detection, b: Detection): boolean {
  return a.start < b.end && b.start < a.end;
}

function addLayer(applied: AppliedDetection[], candidates: Detection[]): void {
  for (const c of candidates) {
    if (!applied.some((a) => overlaps(a, c))) applied.push({ ...c });
  }
  applied.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
}

function token(kind: string): string {
  return `⟦EGRESS:${kind}⟧`;
}

function sample(masked: string, start: number, end: number): string {
  const radius = 60;
  const a = Math.max(0, start - radius);
  const b = Math.min(masked.length, end + radius);
  const prefix = a > 0 ? "..." : "";
  const suffix = b < masked.length ? "..." : "";
  return `${prefix}${masked.slice(a, b)}${suffix}`.replace(/\s+/g, " ").trim();
}

function buildText(input: string, spans: AppliedDetection[]): string {
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += input.slice(last, span.start);
    const replacement = token(span.kind);
    span.outputStart = out.length;
    out += replacement;
    span.outputEnd = out.length;
    last = span.end;
  }
  out += input.slice(last);
  return out;
}

function buildReport(masked: string, spans: AppliedDetection[]): EgressReport {
  const groups = new Map<string, EgressFinding>();
  let totalRedactions = 0;
  let borderlineCount = 0;

  for (const span of spans) {
    if (span.action === "borderline") borderlineCount++;
    else totalRedactions++;

    const key = `${span.action}\0${span.kind}`;
    let finding = groups.get(key);
    if (!finding) {
      finding = { kind: span.kind, action: span.action, count: 0, samples: [] };
      groups.set(key, finding);
    }
    finding.count++;
    if (finding.samples.length < 3 && span.outputStart !== undefined && span.outputEnd !== undefined) {
      finding.samples.push(sample(masked, span.outputStart, span.outputEnd));
    }
  }

  const findings = [...groups.values()].sort((a, b) => {
    if (a.action !== b.action) return a.action === "redacted" ? -1 : 1;
    return b.count - a.count || a.kind.localeCompare(b.kind);
  });

  return { findings, totalRedactions, borderlineCount };
}

export function egressScrub(text: string, opts: { cwd?: string | null; env?: EnvSecret[] }): { text: string; report: EgressReport } {
  const spans: AppliedDetection[] = [];
  addLayer(spans, detectFormat(text));
  addLayer(spans, detectEnvValues(text, opts.cwd, opts.env));
  addLayer(spans, detectEntropy(text));
  const masked = buildText(text, spans);
  return { text: masked, report: buildReport(masked, spans) };
}

