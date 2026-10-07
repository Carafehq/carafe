// Stamped at compile time by scripts/build.ts via `bun build --define`. Running
// from source (bun run src/cli/index.ts) leaves the identifier undeclared, and
// `typeof` on an undeclared identifier is legal JS; source uses the fallback
// below, which the public export stamps independently of the private version.
declare const CARAFE_BUILD_VERSION: string | undefined;
declare const CARAFE_BUILD_TARGET: string | undefined;
declare const CARAFE_BUILD_CHANNEL: string | undefined;

export const VERSION = typeof CARAFE_BUILD_VERSION === "string" ? CARAFE_BUILD_VERSION : "0.1.0";
export const BUILD_TARGET = typeof CARAFE_BUILD_TARGET === "string" ? CARAFE_BUILD_TARGET : "source";

/**
 * The release channel this build belongs to, and the only one it updates from.
 * stable: releases built from main (stable tags and main's alphas).
 */
export const CHANNELS = ["stable",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const isChannel = (value: unknown): value is Channel =>
  typeof value === "string" && (CHANNELS as readonly string[]).includes(value);

export const CHANNEL: Channel =
  typeof CARAFE_BUILD_CHANNEL === "string" && isChannel(CARAFE_BUILD_CHANNEL) ? CARAFE_BUILD_CHANNEL : "stable";

/** `carafe --version`: the channel is named only when it is not stable, so the
 *  stable line stays exactly what install.sh and the release smoke test expect. */
export function versionLine(version: string = VERSION, target: string = BUILD_TARGET, channel: Channel = CHANNEL): string {
  return `carafe ${version} (${target}${channel === "stable" ? "" : `, ${channel}`})`;
}
