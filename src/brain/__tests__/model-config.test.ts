import { describe, expect, it } from "bun:test";
import { listBrainModels } from "../model-config";

describe("brain model discovery", () => {
	it("loads and sorts models from the configured provider", async () => {
		let authorization = "";
		const models = await listBrainModels(
			{
				provider: "openai",
				model: "gpt-5-mini",
				apiKey: "brain-key",
				baseUrl: "https://provider.example/v1",
			},
			async (_input, init) => {
				authorization = new Headers(init?.headers).get("Authorization") || "";
				return Response.json({
					data: [{ id: "gpt-5" }, { id: "gpt-4.1" }, { id: null }],
				});
			},
		);

		expect(authorization).toBe("Bearer brain-key");
		expect(models).toEqual([
			{ id: "gpt-4.1", name: "gpt-4.1" },
			{ id: "gpt-5", name: "gpt-5" },
		]);
	});

	it("requires a configured API key", async () => {
		await expect(listBrainModels({
			provider: "openai",
			model: "gpt-5-mini",
			apiKey: "",
			baseUrl: "https://provider.example/v1",
		})).rejects.toThrow("Configure the brain provider API key");
	});
});
