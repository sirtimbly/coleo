# Semantic Code Search

This project has semantic code search enabled via the `search_code` MCP tool.

## When to Use Semantic Search

**ALWAYS use `search_code` when:**
- Looking for how something is implemented ("how do we handle authentication?")
- Finding where logic lives ("where are errors processed?")
- Searching for code patterns ("find all API endpoint handlers")
- Understanding related functionality ("code related to user sessions")
- The search is conceptual rather than a literal string match
- Finding files that contain specific functions together

**Only use file search / grep when:**
- You need regex pattern matching or counting occurrences
- Looking for files by exact name pattern

## Advanced Filtering

The `search_code` tool supports powerful filtering:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | Natural language description | "authentication logic" |
| `include_extensions` | Only these file types | ".ts,.tsx" |
| `exclude_patterns` | Exclude paths containing | "node_modules,test,.spec" |
| `must_contain` | Exact terms that must appear | "useQuery,useMutation" |
| `must_contain_all` | true=ALL terms, false=ANY | true |

## Examples

Find TypeScript files about hooks:
```
search_code(query="React hooks", include_extensions=".ts,.tsx")
```

Find auth code excluding tests:
```
search_code(query="authentication", exclude_patterns="test,.spec,__tests__")
```

Find files using specific functions together:
```
search_code(
  query="business operations handling",
  must_contain="useBusinessOperations,isMultiOp"
)
```

## Tool Details

The `search_code` tool uses vector embeddings to find semantically similar code.
- Combines semantic understanding with exact term matching
- Returns file paths, relevance scores, and code snippets
- Works best with natural language queries describing what you're looking for

---

# Documentation Search

This project has access to internal documentation via `search_docs` and `search_api` MCP tools.

## `search_docs` - Internal Documentation

Use this when you need to find:
- **GDS Design System**: Component usage, props, variants, design guidelines
- **Engineering Portal**: ADRs, guides, RFCs, best practices
- **API Documentation**: Service capabilities and integration patterns

### Sources

| Source | Content |
|--------|---------|
| `gds` | GDS Design System components and guidelines |
| `eng_portal` | Engineering Portal (ADRs, guides, RFCs) |
| `api` | API specifications |

Leave `sources` empty to search all documentation.

### Examples

Find GDS Button component docs:
```
search_docs(query="Button component variants and props")
```

Search ADRs only:
```
search_docs(query="authentication architecture", sources="eng_portal")
```

## `search_api` - API Specifications

Use this when you need to:
- Find API endpoints for specific capabilities
- Understand request/response formats
- Discover available services and operations

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | What you're looking for | "create field" |
| `service` | Filter by service name | "fields-svc" |
| `method` | Filter by HTTP method | "POST" |

### Examples

Find endpoints for creating fields:
```
search_api(query="create field")
```

Find all POST endpoints in auth service:
```
search_api(query="authentication", service="auth-svc", method="POST")
```

## When to Use Which Tool

| Need | Tool |
|------|------|
| Find code in this project | `search_code` |
| Find GDS component usage | `search_docs` (sources="gds") |
| Find architecture decisions | `search_docs` (sources="eng_portal") |
| Find API endpoints | `search_api` |
