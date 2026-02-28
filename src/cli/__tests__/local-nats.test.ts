import { afterEach, describe, expect, it } from "bun:test";
import { getLocalNatsPaths, getLocalNatsUrl, getNatsDownloadInfo } from "../local-nats";

const ORIGINAL_ENV = {
  COLEO_BIN_DIR: process.env.COLEO_BIN_DIR,
  COLEO_NATS_DATA_DIR: process.env.COLEO_NATS_DATA_DIR,
  COLEO_NATS_PORT: process.env.COLEO_NATS_PORT,
  NATS_BIN: process.env.NATS_BIN,
  NATS_VERSION: process.env.NATS_VERSION,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("local NATS helpers", () => {
  it("derives local runtime paths from the active Coleo directory", () => {
    const paths = getLocalNatsPaths("/tmp/coleo-project/.coleo");

    expect(paths.binaryPath).toBe("/tmp/coleo-project/.coleo/bin/nats-server");
    expect(paths.dataDir).toBe("/tmp/coleo-project/.coleo/nats");
    expect(paths.logPath).toBe("/tmp/coleo-project/.coleo/run/nats.log");
    expect(paths.pidPath).toBe("/tmp/coleo-project/.coleo/run/nats.pid");
  });

  it("builds the local URL from COLEO_NATS_PORT when set", () => {
    process.env.COLEO_NATS_PORT = "5222";
    expect(getLocalNatsUrl()).toBe("nats://127.0.0.1:5222");
  });

  it("builds the pinned release download path for the current platform", () => {
    process.env.NATS_VERSION = "v2.12.3";
    const info = getNatsDownloadInfo();

    expect(info.version).toBe("2.12.3");
    expect(info.archive.startsWith("nats-server-v2.12.3-")).toBe(true);
    expect(info.archive.endsWith(".tar.gz")).toBe(true);
    expect(info.downloadUrl.endsWith(`/${info.archive}`)).toBe(true);
    expect(info.extractedBinaryPath.endsWith("/nats-server")).toBe(true);
  });
});
