import { describe, expect, it } from "bun:test";
import { generateKeyBetween } from "../fractional-indexing";

/**
 * Regression test for infinite loop bug in generateKeyBetween
 * Bug: When generating a key between two consecutive base62 values (e.g., 'a' and 'b'),
 * the function would enter infinite recursion at lines 108-110.
 * 
 * File: src/lib/fractional-indexing.ts
 * Lines: 108-110 (recursive call that doesn't make progress)
 */
describe("generateKeyBetween - infinite loop bug regression", () => {
	it("should not hang when generating key between consecutive values 'a' and 'b'", () => {
		// This test has a 5 second timeout to detect the infinite loop
		// Bug: generateKeyBetween('a', 'b') would recurse infinitely
		// because 'a' (value 10) and 'b' (value 11) are consecutive,
		// leaving no room for a midpoint character.
		// 
		// Previous buggy code at lines 108-110:
		//   const nextA = aKey.slice(0, i + 1);
		//   const nextB = b.slice(0, i + 1) + MIN_KEY;
		//   return generateKeyBetween(nextA, nextB);  // Called with ('a', 'b') again!
		
		const key = generateKeyBetween("a", "b");
		
		// The key should be between 'a' and 'b'
		expect(key > "a").toBe(true);
		expect(key < "b").toBe(true);
		// Should extend 'a' with a middle character
		expect(key.startsWith("a")).toBe(true);
		expect(key.length).toBeGreaterThan(1);
	}, 5000); // 5 second timeout to catch infinite loop

	it("should handle multiple insertions between same consecutive neighbors", () => {
		// Test that we can insert many items between 'a' and 'b' without hanging
		let prev: string | null = "a";
		const next = "b";
		const keys: string[] = [];

		for (let i = 0; i < 10; i++) {
			const key = generateKeyBetween(prev, next);
			keys.push(key);
			expect(key > (prev ?? "")).toBe(true);
			expect(key < next).toBe(true);
			prev = key;
		}

		// Keys should be in ascending order
		for (let i = 1; i < keys.length; i++) {
			expect(keys[i]! > keys[i - 1]!).toBe(true);
		}
	}, 10000);
});
