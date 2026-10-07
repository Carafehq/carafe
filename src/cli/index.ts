#!/usr/bin/env bun
/**
 * The carafe entrypoint: a thin shell that loads every command from ./main.
 * Kept separate so a command that must start fast can be dispatched here
 * before the rest of the CLI is loaded.
 */
await import("./main");

export {};
