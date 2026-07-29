import { afterEach, describe, expect, it } from "bun:test";

import { getServiceCommand } from "../../daemon";

const originalPort = process.env.WEB_UI_PORT;
const originalHost = process.env.WEB_UI_HOST;

afterEach(() => {
  if (originalPort === undefined) delete process.env.WEB_UI_PORT;
  else process.env.WEB_UI_PORT = originalPort;
  if (originalHost === undefined) delete process.env.WEB_UI_HOST;
  else process.env.WEB_UI_HOST = originalHost;
});

describe("web daemon command", () => {
  it("starts the foreground web command with the requested address", () => {
    process.env.WEB_UI_PORT = "5188";
    process.env.WEB_UI_HOST = "127.0.0.1";

    const { command } = getServiceCommand("web");

    expect(command.slice(-5)).toEqual([
      "web",
      "--port",
      "5188",
      "--host",
      "127.0.0.1",
    ]);
    expect(command).not.toContain("serve");
  });
});
