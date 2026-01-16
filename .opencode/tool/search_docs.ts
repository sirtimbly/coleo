import { tool } from "@opencode-ai/plugin";

export default tool({
  description: `Search internal documentation using semantic similarity.

Use this to find:
- GDS Design System components, props, and usage examples
- ADRs (Architecture Decision Records) and engineering decisions
- Engineering guides and best practices
- API documentation

Sources available:
- "gds" - GDS Design System components and guidelines
- "eng_portal" - Engineering Portal (ADRs, guides, RFCs)
- "api" - API specifications

Leave sources empty to search all documentation.`,
  args: {
    query: tool.schema.string().describe("Natural language description of what you're looking for"),
    sources: tool.schema.string().optional().describe("Comma-separated sources to search: 'gds', 'eng_portal', 'api'. Empty = search all."),
    limit: tool.schema.number().optional().describe("Max results to return (default: 10)"),
  },
  async execute(args) {
    const searchArgs = {
      mode: "docs",
      query: args.query,
      sources: args.sources || "",
      limit: args.limit || 10,
    };
    const result = await Bun.$`python3 .opencode/tool/semantic_search.py ${JSON.stringify(searchArgs)}`.text();
    return result.trim();
  },
});
