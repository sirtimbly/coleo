import { tool } from "@opencode-ai/plugin";

export default tool({
  description: `Search API specifications for endpoints and schemas.

Use this to find:
- API endpoints for specific capabilities
- Request/response formats and parameters
- Available services and their operations
- Schema definitions

Available services include: fields-svc, auth-svc, user-svc, activities, crops-svc, 
imagery-api, integrations-svc, and 40+ more Granular services.`,
  args: {
    query: tool.schema.string().describe("What you're looking for, e.g. 'create field', 'user authentication'"),
    service: tool.schema.string().optional().describe("Filter by service name, e.g. 'fields-svc', 'auth-svc'"),
    method: tool.schema.string().optional().describe("Filter by HTTP method: GET, POST, PUT, DELETE, PATCH"),
    limit: tool.schema.number().optional().describe("Max results to return (default: 10)"),
  },
  async execute(args) {
    const searchArgs = {
      mode: "api",
      query: args.query,
      service: args.service || "",
      method: args.method || "",
      limit: args.limit || 10,
    };
    const result = await Bun.$`python3 .opencode/tool/semantic_search.py ${JSON.stringify(searchArgs)}`.text();
    return result.trim();
  },
});
