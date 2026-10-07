import { readdirSync, statSync } from "fs";
import { basename, dirname, extname } from "path";
import { type Checker, pathsIn, plain, shell } from "./types";
export const siblingClaims: Checker = (sentence) => {
  const s = plain(sentence);
  if (!/\b(?:newest|latest|last brief)\b/i.test(s)) return [];
  const named = pathsIn(sentence).find((p) => extname(p.path) !== "");
  if (!named) return [];
  const { path: file, span } = named;
  try {
    const at = statSync(file).mtimeMs;
    const name = basename(file), dir = dirname(file);
    const prefix = name.replace(extname(name), "").replace(/[-_.]?\d.*$/, "");
    const newer = readdirSync(dir).filter((n) => n !== name && n.startsWith(prefix) && extname(n) === extname(name))
      .map((n) => ({ name: n, at: statSync(`${dir}/${n}`).mtimeMs })).filter((n) => n.at > at).sort((a, b) => b.at - a.at)[0];
    return [{ span, label: newer ? `newer file in that folder: ${newer.name} (${new Date(newer.at).toISOString()})` : `no newer sibling of ${name}`, stamp: "?", command: `readdir/stat ${shell(dir)} (mtime)`, checkable: true, value: newer ? "newer sibling observed; meaning of latest unchecked" : "directory checked" }];
  } catch { return [{ span, label: `latest file ${file}`, stamp: "?", checkable: true, value: "directory unavailable" }]; }
};
