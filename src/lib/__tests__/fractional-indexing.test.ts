import { describe, expect, it } from "bun:test";
import {
	generateKeyBetween,
	generateKeysBetween,
	generateInitialKeys,
	compareKeys,
	isValidKey,
} from "../fractional-indexing";

describe("fractional-indexing", () => {
	describe("generateKeyBetween", () => {
		it("should generate 'a' for first item", () => {
			expect(generateKeyBetween(null, null)).toBe("a");
		});

		it("should generate key after existing key", () => {
			expect(generateKeyBetween("a", null)).toBe("b");
			expect(generateKeyBetween("b", null)).toBe("c");
		});

		it("should generate key before existing key", () => {
			expect(generateKeyBetween(null, "b")).toBe("a");
			expect(generateKeyBetween(null, "a")).toBe("Z");
		});

		it("should generate key between two keys", () => {
			const key = generateKeyBetween("a", "c");
			expect(key).toBe("b");
			expect(key > "a").toBe(true);
			expect(key < "c").toBe(true);
		});

		it("should generate key with more precision when needed", () => {
			// When a and b are consecutive, need to add a digit
			const key = generateKeyBetween("a", "b");
			expect(key > "a").toBe(true);
			expect(key < "b").toBe(true);
			// Should be something like "aV" (midpoint)
			expect(key.length).toBeGreaterThan(1);
		});

		it("should handle many insertions between same neighbors", () => {
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
		});

		it("should handle insertion at head", () => {
			const key = generateKeyBetween(null, "a");
			expect(key < "a").toBe(true);
		});

		it("should handle insertion at tail", () => {
			const key = generateKeyBetween("z", null);
			expect(key > "z").toBe(true);
		});

		it("does not regress on consecutive neighbors like 'a' and 'b'", () => {
			const key = generateKeyBetween("a", "b");
			expect(key > "a").toBe(true);
			expect(key < "b").toBe(true);
			expect(key.startsWith("a")).toBe(true);
			expect(key.length).toBeGreaterThan(1);
		}, 5000);
	});

	describe("generateKeysBetween", () => {
		it("should generate multiple keys between two boundaries", () => {
			const keys = generateKeysBetween("a", "d", 2);
			expect(keys).toHaveLength(2);
			expect(keys[0]! > "a").toBe(true);
			expect(keys[0]! < keys[1]!).toBe(true);
			expect(keys[1]! < "d").toBe(true);
		});

		it("should return empty array for n <= 0", () => {
			expect(generateKeysBetween("a", "b", 0)).toEqual([]);
			expect(generateKeysBetween("a", "b", -1)).toEqual([]);
		});

		it("should return single key for n = 1", () => {
			const keys = generateKeysBetween("a", "c", 1);
			expect(keys).toHaveLength(1);
			expect(keys[0]).toBe("b");
		});
	});

	describe("generateInitialKeys", () => {
		it("should generate keys for initial data population", () => {
			const keys = generateInitialKeys(5);
			expect(keys).toEqual(["a", "b", "c", "d", "e"]);
		});

		it("should return empty array for count <= 0", () => {
			expect(generateInitialKeys(0)).toEqual([]);
			expect(generateInitialKeys(-1)).toEqual([]);
		});

		it("should return single key for count = 1", () => {
			expect(generateInitialKeys(1)).toEqual(["a"]);
		});
	});

	describe("compareKeys", () => {
		it("should return negative when a < b", () => {
			expect(compareKeys("a", "b")).toBeLessThan(0);
			expect(compareKeys("a", "aa")).toBeLessThan(0);
		});

		it("should return positive when a > b", () => {
			expect(compareKeys("b", "a")).toBeGreaterThan(0);
			expect(compareKeys("aa", "a")).toBeGreaterThan(0);
		});

		it("should return 0 when a === b", () => {
			expect(compareKeys("a", "a")).toBe(0);
			expect(compareKeys("abc", "abc")).toBe(0);
		});
	});

	describe("isValidKey", () => {
		it("should accept valid base62 keys", () => {
			expect(isValidKey("a")).toBe(true);
			expect(isValidKey("abc")).toBe(true);
			expect(isValidKey("ABC")).toBe(true);
			expect(isValidKey("123")).toBe(true);
			expect(isValidKey("aB3")).toBe(true);
		});

		it("should accept empty string", () => {
			expect(isValidKey("")).toBe(true);
		});

		it("should reject invalid characters", () => {
			expect(isValidKey("a-b")).toBe(false);
			expect(isValidKey("a_b")).toBe(false);
			expect(isValidKey("a.b")).toBe(false);
			expect(isValidKey("a b")).toBe(false);
		});
	});

	describe("stress test", () => {
		it("should handle many sequential insertions", () => {
			let prev: string | null = null;
			const keys: string[] = [];

			// Insert 100 keys
			for (let i = 0; i < 100; i++) {
				const key = generateKeyBetween(prev, null);
				keys.push(key);
				prev = key;
			}

			// Verify all keys are in ascending order
			for (let i = 1; i < keys.length; i++) {
				expect(keys[i]! > keys[i - 1]!).toBe(true);
			}
		});

		it("should handle insertions between same two keys", () => {
			const a = "a";
			const b = "b";
			let prev: string | null = a;
			const keys: string[] = [];

			// Insert 50 keys between a and b
			for (let i = 0; i < 50; i++) {
				const key = generateKeyBetween(prev, b);
				keys.push(key);
				expect(key > (prev ?? "")).toBe(true);
				expect(key < b).toBe(true);
				prev = key;
			}

			// Verify ascending order
			for (let i = 1; i < keys.length; i++) {
				expect(keys[i]! > keys[i - 1]!).toBe(true);
			}
		});

		it("should keep making progress between consecutive neighbors", () => {
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

			for (let i = 1; i < keys.length; i++) {
				expect(keys[i]! > keys[i - 1]!).toBe(true);
			}
		}, 10000);
	});
});
