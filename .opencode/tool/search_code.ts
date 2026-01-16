import { tool } from "@opencode-ai/plugin";

export default tool({
  description: `Semantic code search with advanced filtering - finds code by meaning, not just keywords.

Use this FIRST when looking for:
- How something is implemented ("how do we handle auth?")
- Where logic lives ("where are errors processed?")
- Code patterns ("find API endpoint handlers")
- Related functionality ("code related to user sessions")

Supports filtering by:
- File extensions (include_extensions: ".ts,.tsx")
- Path exclusions (exclude_patterns: "node_modules,test,.spec")
- Required terms (must_contain: "functionName,otherTerm")

This is faster and more accurate than grep/glob for understanding code.`,
  args: {
    query: tool.schema.string().describe("Natural language description of what you're looking for"),
    limit: tool.schema.number().optional().describe("Max results to return (default: 10)"),
    include_extensions: tool.schema.string().optional().describe("Comma-separated file extensions to include, e.g. '.ts,.tsx' or '*.py'"),
    exclude_patterns: tool.schema.string().optional().describe("Comma-separated patterns to exclude, e.g. 'node_modules,test,.spec'"),
    must_contain: tool.schema.string().optional().describe("Comma-separated terms that MUST appear in the code (exact match)"),
    must_contain_all: tool.schema.boolean().optional().describe("If true (default), ALL must_contain terms required. If false, ANY term matches."),
  },
  async execute(args) {
    const searchArgs = {
      query: args.query,
      limit: args.limit || 10,
      include_extensions: args.include_extensions || "",
      exclude_patterns: args.exclude_patterns || "",
      must_contain: args.must_contain || "",
      must_contain_all: args.must_contain_all ?? true,
    };
    const result = await Bun.$`python3 .opencode/tool/semantic_search.py ${JSON.stringify(searchArgs)}`.text();
    return result.trim();
  },
});
