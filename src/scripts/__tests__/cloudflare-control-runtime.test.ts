import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url);

describe("Cloudflare control runtime", () => {
  test("packages the pinned Qdrant binary", async () => {
    const dockerfile = await Bun.file(new URL("Dockerfile.cloudflare-control", repositoryRoot)).text();

    expect(dockerfile).toContain("FROM qdrant/qdrant:v1.18.0 AS qdrant");
    expect(dockerfile).toContain("COPY --from=qdrant /qdrant/qdrant /usr/local/bin/qdrant");
  });

  test("runs the transcript indexer after Qdrant and the API are ready", async () => {
    const entrypoint = await Bun.file(
      new URL("docker/cloudflare-control-entrypoint.sh", repositoryRoot),
    ).text();

    expect(entrypoint.indexOf('qdrant "${qdrant_args[@]}" &')).toBeGreaterThan(-1);
    expect(entrypoint.indexOf("bun /home/coleo/coleo/src/scripts/jetstream-transcript-indexer.ts &")).toBeGreaterThan(
      entrypoint.indexOf('curl -fsS "http://127.0.0.1:${PORT}/api/health"'),
    );
  });

  test("persists consistent snapshots instead of live Qdrant storage", async () => {
    const entrypoint = await Bun.file(
      new URL("docker/cloudflare-control-entrypoint.sh", repositoryRoot),
    ).text();

    expect(entrypoint).toContain('--exclude "qdrant/storage/*"');
    expect(entrypoint).toContain('curl -fsS -X POST "${QDRANT_URL}/snapshots?wait=true"');
    expect(entrypoint).toContain('qdrant_args+=(--storage-snapshot "$QDRANT_BACKUP_FILE")');
  });
});
