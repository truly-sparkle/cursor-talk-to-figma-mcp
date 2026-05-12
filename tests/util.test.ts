/**
 * BL-031: minimal Bun test seed.
 *
 * Run: `bun test`. New tests should live next to the unit they cover
 * (e.g. tests/server/foo.test.ts) or under a single tests/ tree —
 * pick whichever matches the file layout that wins.
 *
 * The first thing worth covering is small pure utilities that have
 * already burned us once (color clamping, ES compat). The more
 * interesting integration tests (relay channel routing, MCP tool
 * round-trips through a fake plugin) come later.
 */

import { describe, expect, test } from "bun:test";

// --- Pure helper extracted to test ---------------------------------
// Mirror of server.ts:channelToByte (BL-006). Kept here so the test
// runs without booting the MCP server — when the helper graduates to
// its own module, this duplicate goes away.
function channelToByte(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.round(Math.max(0, Math.min(1, n)) * 255);
}

describe("channelToByte (BL-006)", () => {
  test("clamps in-range values normally", () => {
    expect(channelToByte(0)).toBe(0);
    expect(channelToByte(1)).toBe(255);
    expect(channelToByte(0.5)).toBe(128);
  });

  test("clamps out-of-range to [0, 255]", () => {
    expect(channelToByte(1.5)).toBe(255);
    expect(channelToByte(-0.2)).toBe(0);
    expect(channelToByte(2)).toBe(255);
  });

  test("treats NaN / Infinity / non-number as 0", () => {
    expect(channelToByte(NaN)).toBe(0);
    expect(channelToByte(Infinity)).toBe(0);
    expect(channelToByte(-Infinity)).toBe(0);
    expect(channelToByte(undefined)).toBe(0);
    expect(channelToByte(null)).toBe(0);
    expect(channelToByte("0.5")).toBe(0); // strings aren't auto-coerced
  });
});

describe("channel name regex (BL-004)", () => {
  // Mirror of socket.ts:CHANNEL_NAME_RE
  const RE = /^[a-zA-Z0-9_-]{1,64}$/;

  test("accepts valid names", () => {
    expect(RE.test("abc")).toBe(true);
    expect(RE.test("My_channel-1")).toBe(true);
    expect(RE.test("a".repeat(64))).toBe(true);
  });

  test("rejects empty and overlong", () => {
    expect(RE.test("")).toBe(false);
    expect(RE.test("a".repeat(65))).toBe(false);
  });

  test("rejects special chars", () => {
    expect(RE.test("a b")).toBe(false);
    expect(RE.test("a/b")).toBe(false);
    expect(RE.test("a.b")).toBe(false);
    expect(RE.test("한글")).toBe(false);
  });
});
