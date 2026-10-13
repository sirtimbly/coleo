import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isBuiltWebDist } from "../commands/web";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("isBuiltWebDist", () => {
  it("rejects the source web workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "coleo-web-src-"));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, "index.html"),
      [
        "<!doctype html>",
        '<html lang="en">',
        "<body>",
        '  <div id="root"></div>',
        '  <script type="module" src="/src/main.tsx"></script>',
        "</body>",
        "</html>",
      ].join("\n"),
    );

    expect(isBuiltWebDist(dir)).toBe(false);
  });

  it("accepts a built Vite dist directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "coleo-web-dist-"));
    tempDirs.push(dir);

    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('ok');");
    writeFileSync(
      join(dir, "index.html"),
      [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '  <script type="module" crossorigin src="/assets/index-abc123.js"></script>',
        "</head>",
        "<body>",
        '  <div id="root"></div>',
        "</body>",
        "</html>",
      ].join("\n"),
    );

    expect(isBuiltWebDist(dir)).toBe(true);
  });
});
