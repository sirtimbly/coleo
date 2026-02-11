/**
 * Fractional indexing / lexicographic order key utilities
 * 
 * This module provides functions for generating order keys that support
 * efficient reordering without updating all rows. Uses base62 encoding
 * to generate keys between two existing keys.
 * 
 * Algorithm based on fractional indexing used in collaborative editors.
 * Keys are variable-length strings that can be inserted between any
 * two existing keys.
 */

// Base62 alphabet ordered by ASCII values for proper lexicographic sorting
// ASCII order: 0-9 (48-57), A-Z (65-90), a-z (97-122)
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = BASE62.length; // 62

// Minimum and maximum key values (for head/tail insertions)
export const MIN_KEY = "";
export const MAX_KEY = "~"; // Character after all base62 chars

/**
 * Get the character code for a base62 digit
 */
function charToVal(char: string): number {
	const idx = BASE62.indexOf(char);
	if (idx === -1) {
		throw new Error(`Invalid character in order key: ${char}`);
	}
	return idx;
}

/**
 * Get the base62 digit for a value (0-61)
 */
function valToChar(val: number): string {
	if (val < 0 || val >= BASE) {
		throw new Error(`Value out of range: ${val}`);
	}
	return BASE62[val]!;
}

/**
 * Generate an order key between two existing keys.
 * 
 * @param a - The key before (null/undefined for head insertion)
 * @param b - The key after (null/undefined for tail insertion)
 * @returns A new key that sorts between a and b
 * 
 * Examples:
 *   generateKeyBetween(null, null) -> "a"
 *   generateKeyBetween("a", null) -> "b"
 *   generateKeyBetween("a", "b") -> "aV" (midpoint)
 *   generateKeyBetween("a", "aV") -> "aG" (midpoint)
 */
export function generateKeyBetween(
	a: string | null | undefined,
	b: string | null | undefined
): string {
	// Handle head insertion
	if (!a) {
		if (!b) {
			// First item
			return "a";
		}
		// Insert at head - generate key before b
		return generateKeyBefore(b);
	}

	// Handle tail insertion
	if (!b || b === MAX_KEY) {
		// Insert at tail - generate key after a
		return generateKeyAfter(a!);
	}

	// At this point, a is guaranteed to be non-null
	const aKey = a as string;

	// Find common prefix
	let i = 0;
	while (i < aKey.length && i < b.length && aKey[i] === b[i]) {
		i++;
	}

	const aSuffix = i < aKey.length ? aKey.slice(i) : "";
	const bSuffix = i < b.length ? b.slice(i) : "";

	// If a is a prefix of b, we need to extend a
	if (!aSuffix) {
		// a is a prefix of b, e.g., "a" and "ab"
		// Generate something like "aV" (midpoint between "a" and "b")
		return aKey + "V";
	}

	// Get first differing characters
	const aChar = aSuffix[0]!;
	const bChar = bSuffix[0]!;
	const aVal = charToVal(aChar);
	const bVal = charToVal(bChar);

	// If there's room between the characters, use midpoint
	if (bVal - aVal > 1) {
		const midVal = Math.floor((aVal + bVal) / 2);
		return aKey.slice(0, i) + valToChar(midVal);
	}

	// No room between characters, need to add a digit
	// Extend a with a middle character to create room
	return aKey + "V";
}

/**
 * Generate a key that comes after the given key
 */
function generateKeyAfter(key: string): string {
	if (!key) {
		return "a";
	}

	// Try to increment the last character
	const lastChar = key[key.length - 1]!;
	const lastVal = charToVal(lastChar);

	if (lastVal < BASE - 1) {
		// Can increment last character
		return key.slice(0, -1) + valToChar(lastVal + 1);
	}

	// Last char is 'Z' (max), need to extend
	// Add 'a' to create more room
	return key + "a";
}

/**
 * Generate a key that comes before the given key
 */
function generateKeyBefore(key: string): string {
	if (!key) {
		return "a";
	}

	// Try to decrement the last character
	const lastChar = key[key.length - 1]!;
	const lastVal = charToVal(lastChar);

	if (lastVal > 0) {
		// Can decrement last character
		return key.slice(0, -1) + valToChar(lastVal - 1);
	}

	// Last char is '0' (min), need to handle carefully
	// Remove the last char and try again with parent
	if (key.length > 1) {
		return generateKeyBetween(key.slice(0, -1), key);
	}

	// Single char at minimum, prepend a lower char
	// This shouldn't happen often in practice
	return "0" + key;
}

/**
 * Generate multiple keys between two existing keys.
 * Useful for batch insertions.
 * 
 * @param a - The key before
 * @param b - The key after  
 * @param n - Number of keys to generate
 * @returns Array of n keys that sort between a and b
 */
export function generateKeysBetween(
	a: string | null | undefined,
	b: string | null | undefined,
	n: number
): string[] {
	if (n <= 0) return [];
	if (n === 1) return [generateKeyBetween(a, b)];

	const keys: string[] = [];
	let prev: string | null | undefined = a;

	for (let i = 0; i < n; i++) {
		// For evenly distributed keys, we need to leave room
		// Generate intermediate boundary for next key
		const next = i === n - 1 ? b : generateKeyBetween(prev, b);
		const key = generateKeyBetween(prev, next);
		keys.push(key);
		prev = key;
	}

	return keys;
}

/**
 * Generate initial keys for a list of items.
 * Creates evenly spaced keys for initial data population.
 * 
 * @param count - Number of keys to generate
 * @returns Array of keys sorted in ascending order
 */
export function generateInitialKeys(count: number): string[] {
	if (count <= 0) return [];
	if (count === 1) return ["a"];

	// Generate evenly spaced keys
	// Use a simple approach: a, b, c, ... za, zb, etc.
	const keys: string[] = [];
	let current = "a";

	for (let i = 0; i < count; i++) {
		keys.push(current);
		current = generateKeyAfter(current);
	}

	return keys;
}

/**
 * Compare two order keys for sorting.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareKeys(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/**
 * Validate that a string is a valid order key.
 */
export function isValidKey(key: string): boolean {
	if (!key) return true; // Empty string is valid (represents head)
	for (const char of key) {
		if (BASE62.indexOf(char) === -1) {
			return false;
		}
	}
	return true;
}

/**
 * Generate a deterministic tie-breaker suffix for concurrent inserts.
 * Appends a short client identifier to ensure consistent ordering
 * when multiple clients insert between the same keys simultaneously.
 * 
 * @param clientId - A short unique identifier for the client (e.g., "c1", "c2")
 * @returns Suffix string to append to the key
 */
export function generateTieBreakerSuffix(clientId: string): string {
	// Use a separator character not in base62 to ensure proper sorting
	// '_' sorts after all base62 characters
	return `_${clientId}`;
}
