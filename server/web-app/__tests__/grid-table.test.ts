import { describe, expect, it } from "bun:test";
import { selectedValuesFilter, selectedTagsFilter, formatGridDate } from "../src/components/grid-table";
import type { Row } from "@tanstack/react-table";

function mockRow<T>(value: T): Row<T> {
  return {
    getValue: () => value,
  } as unknown as Row<T>;
}

describe("grid-table filters", () => {
  describe("selectedValuesFilter", () => {
    it("returns true when no values are selected", () => {
      expect(selectedValuesFilter(mockRow("open"), "status", [])).toBe(true);
      expect(selectedValuesFilter(mockRow("open"), "status", undefined)).toBe(true);
    });

    it("matches when the row value is in the selected values", () => {
      expect(selectedValuesFilter(mockRow("open"), "status", ["open", "resolved"])).toBe(true);
    });

    it("does not match when the row value is not selected", () => {
      expect(selectedValuesFilter(mockRow("closed"), "status", ["open", "resolved"])).toBe(false);
    });
  });

  describe("selectedTagsFilter", () => {
    it("returns true when no tags are selected", () => {
      expect(selectedTagsFilter(mockRow(["bug"]), "tags", [])).toBe(true);
    });

    it("matches when any row tag is selected", () => {
      expect(selectedTagsFilter(mockRow(["bug", "ui"]), "tags", ["ui"])).toBe(true);
    });

    it("does not match when no row tags are selected", () => {
      expect(selectedTagsFilter(mockRow(["bug"]), "tags", ["ui"])).toBe(false);
    });

    it("handles non-array tag values gracefully", () => {
      expect(selectedTagsFilter(mockRow("bug"), "tags", ["bug"])).toBe(false);
    });
  });

  describe("formatGridDate", () => {
    it("formats valid ISO dates", () => {
      const formatted = formatGridDate("2026-07-28T12:00:00.000Z");
      expect(formatted).toContain("2026");
    });

    it("returns the raw value for invalid dates", () => {
      expect(formatGridDate("not-a-date")).toBe("not-a-date");
    });
  });
});
