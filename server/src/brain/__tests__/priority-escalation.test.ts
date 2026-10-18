import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { findLargeFiles, groupLargeFilesByDomain, type LargeFileInfo } from "../utils/find-large-files";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";

describe("Priority escalation for files >600 lines", () => {
  const testDir = join("/tmp", `coleo-priority-escalation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const srcDir = join(testDir, "src");

  beforeEach(async () => {
    await mkdir(srcDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("findLargeFiles utility", () => {
    it("should identify high priority files (>600 lines)", async () => {
      // Create files of different sizes
      const highPriorityContent = Array(650).fill("// line").join("\n");
      const normalPriorityContent = Array(450).fill("// line").join("\n");
      
      await mkdir(join(srcDir, "module-a"), { recursive: true });
      await writeFile(join(srcDir, "module-a", "high-priority.ts"), highPriorityContent);
      await writeFile(join(srcDir, "module-a", "normal-priority.ts"), normalPriorityContent);

      const files = await findLargeFiles({
        rootDir: testDir,
        srcDir: srcDir,
        minLines: 600,
        thresholds: { normal: 400, high: 600, critical: 800 },
      });

      // Should find the high priority file
      const highPriorityFile = files.find(f => f.relativePath.includes("high-priority.ts"));
      expect(highPriorityFile).toBeDefined();
      expect(highPriorityFile?.lines).toBe(650);
      expect(highPriorityFile?.bucket).toBe("high");

      // Should NOT find the normal priority file (below minLines threshold)
      const normalPriorityFile = files.find(f => f.relativePath.includes("normal-priority.ts"));
      expect(normalPriorityFile).toBeUndefined();
    });

    it("should identify critical priority files (>800 lines)", async () => {
      const criticalContent = Array(850).fill("// line").join("\n");
      
      await mkdir(join(srcDir, "module-b"), { recursive: true });
      await writeFile(join(srcDir, "module-b", "critical-file.ts"), criticalContent);

      const files = await findLargeFiles({
        rootDir: testDir,
        srcDir: srcDir,
        minLines: 600,
        thresholds: { normal: 400, high: 600, critical: 800 },
      });

      const criticalFile = files.find(f => f.relativePath.includes("critical-file.ts"));
      expect(criticalFile).toBeDefined();
      expect(criticalFile?.lines).toBe(850);
      expect(criticalFile?.bucket).toBe("critical");
    });

    it("should identify normal priority files (400-600 lines) when minLines is lower", async () => {
      const normalContent = Array(450).fill("// line").join("\n");
      
      await mkdir(join(srcDir, "module-c"), { recursive: true });
      await writeFile(join(srcDir, "module-c", "normal-file.ts"), normalContent);

      const files = await findLargeFiles({
        rootDir: testDir,
        srcDir: srcDir,
        minLines: 400,
        thresholds: { normal: 400, high: 600, critical: 800 },
      });

      const normalFile = files.find(f => f.relativePath.includes("normal-file.ts"));
      expect(normalFile).toBeDefined();
      expect(normalFile?.lines).toBe(450);
      expect(normalFile?.bucket).toBe("normal");
    });

    it("should sort files by line count descending", async () => {
      const criticalContent = Array(850).fill("// line").join("\n");
      const highContent = Array(650).fill("// line").join("\n");
      const normalContent = Array(450).fill("// line").join("\n");
      
      await mkdir(join(srcDir, "module-d"), { recursive: true });
      await writeFile(join(srcDir, "module-d", "z-file.ts"), normalContent);
      await writeFile(join(srcDir, "module-d", "a-file.ts"), criticalContent);
      await writeFile(join(srcDir, "module-d", "m-file.ts"), highContent);

      const files = await findLargeFiles({
        rootDir: testDir,
        srcDir: srcDir,
        minLines: 400,
        thresholds: { normal: 400, high: 600, critical: 800 },
      });

      // Should be sorted by line count descending
      expect(files[0]?.lines).toBe(850);
      expect(files[1]?.lines).toBe(650);
      expect(files[2]?.lines).toBe(450);
    });
  });

  describe("groupLargeFilesByDomain", () => {
    it("should group files by their domain (first directory)", () => {
      const files: LargeFileInfo[] = [
        {
          path: "/test/src/brain/file1.ts",
          relativePath: "src/brain/file1.ts",
          lines: 700,
          domain: "brain",
          bucket: "high",
        },
        {
          path: "/test/src/brain/file2.ts",
          relativePath: "src/brain/file2.ts",
          lines: 500,
          domain: "brain",
          bucket: "normal",
        },
        {
          path: "/test/src/api/file1.ts",
          relativePath: "src/api/file1.ts",
          lines: 900,
          domain: "api",
          bucket: "critical",
        },
      ];

      const grouped = groupLargeFilesByDomain(files);

      expect(grouped["brain"]).toHaveLength(2);
      expect(grouped["api"]).toHaveLength(1);
      expect(grouped["brain"]?.[0]?.lines).toBe(700);
      expect(grouped["api"]?.[0]?.lines).toBe(900);
    });
  });

  describe("Priority escalation logic", () => {
    it("should use correct thresholds for priority buckets", async () => {
      const normalContent = Array(450).fill("// line").join("\n");
      const highContent = Array(650).fill("// line").join("\n");
      const criticalContent = Array(850).fill("// line").join("\n");
      
      await mkdir(join(srcDir, "test"), { recursive: true });
      await writeFile(join(srcDir, "test", "normal.ts"), normalContent);
      await writeFile(join(srcDir, "test", "high.ts"), highContent);
      await writeFile(join(srcDir, "test", "critical.ts"), criticalContent);

      const files = await findLargeFiles({
        rootDir: testDir,
        srcDir: srcDir,
        minLines: 400,
        thresholds: { normal: 400, high: 600, critical: 800 },
      });

      const normalFile = files.find(f => f.relativePath.includes("normal.ts"));
      const highFile = files.find(f => f.relativePath.includes("high.ts"));
      const criticalFile = files.find(f => f.relativePath.includes("critical.ts"));

      expect(normalFile?.bucket).toBe("normal");
      expect(highFile?.bucket).toBe("high");
      expect(criticalFile?.bucket).toBe("critical");
    });

    it("should handle edge cases at threshold boundaries", async () => {
      // Files exactly at threshold boundaries
      const at400 = Array(401).fill("// line").join("\n"); // Just over 400
      const at600 = Array(601).fill("// line").join("\n"); // Just over 600
      const at800 = Array(801).fill("// line").join("\n"); // Just over 800
      
      await mkdir(join(srcDir, "boundaries"), { recursive: true });
      await writeFile(join(srcDir, "boundaries", "at400.ts"), at400);
      await writeFile(join(srcDir, "boundaries", "at600.ts"), at600);
      await writeFile(join(srcDir, "boundaries", "at800.ts"), at800);

      const files = await findLargeFiles({
        rootDir: testDir,
        srcDir: srcDir,
        minLines: 400,
        thresholds: { normal: 400, high: 600, critical: 800 },
      });

      const file400 = files.find(f => f.relativePath.includes("at400.ts"));
      const file600 = files.find(f => f.relativePath.includes("at600.ts"));
      const file800 = files.find(f => f.relativePath.includes("at800.ts"));

      expect(file400?.bucket).toBe("normal");
      expect(file600?.bucket).toBe("high");
      expect(file800?.bucket).toBe("critical");
    });
  });
});
