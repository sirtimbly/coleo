#!/usr/bin/env python3
"""
Semantic search tool for OpenCode.

Supports multiple search modes:
- "code" (default): Search project codebase
- "docs": Search internal documentation (GDS, Eng Portal, APIs)
- "api": Search API specifications

Usage from OpenCode:
  {"query": "how do we handle authentication", "limit": 10}
  {"mode": "docs", "query": "Button component usage"}
  {"mode": "api", "query": "create field", "service": "fields-svc"}
"""

import os
import sys
import json
import hashlib
import fnmatch
import requests
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

# Configuration
EMBEDDING_URL = os.getenv("EMBEDDING_URL", "http://localhost:8787/v1/embeddings")
EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5"
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
COLLECTION_FILE = ".code-search-collection"

# Documentation collection names
DOCS_COLLECTIONS = {
    "gds": "docs_gds",
    "eng_portal": "docs_eng_portal",
    "api": "docs_api_specs",
}

client = QdrantClient(url=QDRANT_URL)


def get_collection_name(override: str | None = None) -> str:
    """
    Determine the collection name to search.

    Priority:
    1. Explicit override (from query args)
    2. CODE_SEARCH_COLLECTION environment variable
    3. .code-search-collection file in current directory (or parents)
    4. Deterministic hash of current directory
    """
    # 1. Explicit override
    if override:
        return override

    # 2. Environment variable
    env_collection = os.getenv("CODE_SEARCH_COLLECTION")
    if env_collection:
        return env_collection

    # 3. Look for .code-search-collection file (search up to root)
    cwd = os.getcwd()
    current = cwd
    while current != "/":
        collection_file = os.path.join(current, COLLECTION_FILE)
        if os.path.exists(collection_file):
            try:
                with open(collection_file, "r") as f:
                    name = f.read().strip()
                    if name:
                        return name
            except Exception:
                pass
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    # 4. Deterministic hash of current directory
    path_hash = hashlib.sha256(cwd.encode()).hexdigest()[:12]
    return f"codebase_{path_hash}"


def get_embedding(text: str) -> list[float]:
    """Fetch embedding for a text string."""
    response = requests.post(
        EMBEDDING_URL,
        json={"input": text, "model": EMBEDDING_MODEL},
        headers={"Content-Type": "application/json"},
    )
    response.raise_for_status()
    return response.json()["data"][0]["embedding"]


def matches_pattern(path: str, pattern: str) -> bool:
    """Check if a path matches a glob-like pattern."""
    # Handle simple extension patterns like ".ts" or "*.ts"
    if pattern.startswith("."):
        return path.endswith(pattern)
    if pattern.startswith("*."):
        return path.endswith(pattern[1:])
    # Handle directory patterns like "src/"
    if pattern.endswith("/"):
        return f"/{pattern}" in path or path.startswith(pattern)
    # Handle glob patterns
    if "*" in pattern or "?" in pattern:
        return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(
            os.path.basename(path), pattern
        )
    # Simple substring match
    return pattern.lower() in path.lower()


def matches_any_pattern(path: str, patterns: list[str]) -> bool:
    """Check if path matches any of the patterns."""
    if not patterns:
        return True
    return any(matches_pattern(path, p) for p in patterns)


def matches_exclude_pattern(path: str, excludes: list[str]) -> bool:
    """Check if path should be excluded."""
    for pattern in excludes:
        if matches_pattern(path, pattern):
            return True
    return False


def content_matches_terms(
    content: str, must_contain: list[str], match_all: bool = True
) -> bool:
    """Check if content contains required terms."""
    if not must_contain:
        return True

    content_lower = content.lower()
    if match_all:
        return all(term.lower() in content_lower for term in must_contain)
    else:
        return any(term.lower() in content_lower for term in must_contain)


def search(
    query: str,
    limit: int = 10,
    collection: str | None = None,
    include_extensions: str = "",
    exclude_patterns: str = "",
    must_contain: str = "",
    must_contain_all: bool = True,
) -> list[dict]:
    """
    Search the codebase for semantically similar code with filtering.

    Args:
        query: The search query
        limit: Maximum number of results to return
        collection: Optional collection name override
        include_extensions: Comma-separated file extensions to include
        exclude_patterns: Comma-separated patterns to exclude
        must_contain: Comma-separated terms that must appear in code
        must_contain_all: If True, all terms must match; if False, any term

    Returns:
        List of search results with file paths, scores, and snippets
    """
    collection_name = get_collection_name(collection)

    # Check if collection exists
    try:
        collections = client.get_collections().collections
        if not any(c.name == collection_name for c in collections):
            return [
                {
                    "error": f"Collection '{collection_name}' not found. "
                    f"Run 'python index.py --save-collection' in your project first."
                }
            ]
    except Exception as e:
        return [{"error": f"Could not connect to Qdrant: {e}"}]

    query_vector = get_embedding(query)

    # Parse filter parameters
    include_list = [x.strip() for x in include_extensions.split(",") if x.strip()]
    exclude_list = [x.strip() for x in exclude_patterns.split(",") if x.strip()]
    must_contain_list = [x.strip() for x in must_contain.split(",") if x.strip()]

    # Search with higher limit to account for filtering
    filter_multiplier = 1
    if include_list:
        filter_multiplier += 2
    if exclude_list:
        filter_multiplier += 1
    if must_contain_list:
        filter_multiplier += 3  # Content filtering is most restrictive

    search_limit = min(limit * filter_multiplier, 100)

    # Use query_points (new API in qdrant-client 1.10+)
    results = client.query_points(
        collection_name=collection_name,
        query=query_vector,
        limit=search_limit,
        with_payload=True,
    )

    output = []
    for point in results.points:
        payload = point.payload or {}
        file_path = payload.get("path", "")
        content = payload.get("content", "")

        # Apply extension filter
        if include_list and not matches_any_pattern(file_path, include_list):
            continue

        # Apply exclusion filter
        if exclude_list and matches_exclude_pattern(file_path, exclude_list):
            continue

        # Apply must_contain filter
        if must_contain_list and not content_matches_terms(
            content, must_contain_list, must_contain_all
        ):
            continue

        snippet = content[:500] + "..." if len(content) > 500 else content
        output.append(
            {
                "file": file_path,
                "score": round(point.score, 4),
                "snippet": snippet,
            }
        )

        if len(output) >= limit:
            break

    # Add collection info to first result for debugging
    if output:
        output[0]["_collection"] = collection_name

    # If we didn't find enough results with must_contain, note it
    if must_contain_list and len(output) == 0:
        return [
            {
                "results": [],
                "note": f"No results found containing terms: {must_contain_list}. "
                "Try with must_contain_all=false or fewer terms.",
            }
        ]

    return output


# =============================================================================
# Documentation Search
# =============================================================================


def search_collection(
    collection_name: str,
    query: str,
    limit: int = 10,
    filters: dict | None = None,
) -> list[dict]:
    """Search a specific Qdrant collection."""
    # Check if collection exists
    try:
        collections = client.get_collections().collections
        if not any(c.name == collection_name for c in collections):
            return []
    except Exception:
        return []

    # Get embedding
    try:
        query_vector = get_embedding(query)
    except Exception:
        return []

    # Build Qdrant filter if provided
    qdrant_filter = None
    if filters:
        conditions = []
        for key, value in filters.items():
            if value:
                conditions.append(
                    FieldCondition(key=key, match=MatchValue(value=value))
                )
        if conditions:
            qdrant_filter = Filter(must=conditions)

    # Search
    results = client.query_points(
        collection_name=collection_name,
        query=query_vector,
        limit=limit,
        with_payload=True,
        query_filter=qdrant_filter,
    )

    output = []
    for point in results.points:
        payload = point.payload or {}
        output.append(
            {
                "score": round(point.score, 4),
                **payload,
            }
        )

    return output


def search_docs(
    query: str,
    sources: str = "",
    limit: int = 10,
) -> list[dict]:
    """
    Search internal documentation.

    Args:
        query: Natural language query
        sources: Comma-separated sources: "gds", "eng_portal", "api"
        limit: Max results
    """
    # Parse sources
    source_list = [s.strip().lower() for s in sources.split(",") if s.strip()]

    # Determine collections to search
    if source_list:
        collections_to_search = [
            DOCS_COLLECTIONS[s] for s in source_list if s in DOCS_COLLECTIONS
        ]
        if not collections_to_search:
            return [
                {
                    "error": f"Unknown sources: {source_list}. Valid: gds, eng_portal, api"
                }
            ]
    else:
        collections_to_search = list(DOCS_COLLECTIONS.values())

    # Search each collection
    all_results = []
    for collection in collections_to_search:
        results = search_collection(collection, query, limit=limit)
        for r in results:
            r["collection"] = collection
        all_results.extend(results)

    # Sort by score and limit
    all_results.sort(key=lambda x: x.get("score", 0), reverse=True)
    all_results = all_results[:limit]

    if not all_results:
        try:
            existing = {c.name for c in client.get_collections().collections}
            missing = [c for c in collections_to_search if c not in existing]
            if missing:
                return [
                    {
                        "note": f"Documentation not indexed yet: {missing}. "
                        "Run: python index_docs.py --config docs_config.yaml"
                    }
                ]
        except Exception:
            pass
        return [{"note": "No matching documentation found."}]

    # Format output
    output = []
    for r in all_results:
        content = r.get("content", "")
        snippet = content[:600] + "..." if len(content) > 600 else content
        output.append(
            {
                "file": r.get("path", ""),
                "source": r.get("source", r.get("collection", "")),
                "type": r.get("type", "docs"),
                "score": r.get("score", 0),
                "snippet": snippet,
            }
        )

    return output


def search_api(
    query: str,
    service: str = "",
    method: str = "",
    limit: int = 10,
) -> list[dict]:
    """
    Search API specifications.

    Args:
        query: What you're looking for
        service: Filter by service name
        method: Filter by HTTP method
        limit: Max results
    """
    collection = DOCS_COLLECTIONS.get("api", "docs_api_specs")

    # Build filters
    filters = {}
    if service:
        filters["service"] = service
    if method:
        filters["method"] = method.upper()

    search_limit = limit * 3 if filters else limit
    results = search_collection(
        collection, query, limit=search_limit, filters=filters if filters else None
    )

    if not results:
        try:
            existing = {c.name for c in client.get_collections().collections}
            if collection not in existing:
                return [
                    {
                        "note": f"API specs not indexed. "
                        "Run: python index_docs.py --config docs_config.yaml --source api_specs"
                    }
                ]
        except Exception:
            pass
        return [{"note": "No matching API endpoints found."}]

    # Format output
    output = []
    for r in results:
        entry = {
            "service": r.get("service", ""),
            "type": r.get("type", ""),
            "score": r.get("score", 0),
        }

        if r.get("type") == "endpoint":
            entry.update(
                {
                    "method": r.get("method", ""),
                    "path": r.get("endpoint_path", r.get("path", "")),
                    "description": r.get("content", "")[:300],
                    "tags": r.get("tags", []),
                }
            )
        elif r.get("type") == "schema":
            entry.update(
                {
                    "schema_name": r.get("schema_name", ""),
                    "description": r.get("content", "")[:300],
                }
            )
        else:
            entry["description"] = r.get("content", "")[:300]

        output.append(entry)

        if len(output) >= limit:
            break

    return output


if __name__ == "__main__":
    # OpenCode passes arguments as a JSON string in sys.argv[1]
    args = json.loads(sys.argv[1])
    mode = args.get("mode", "code")
    query = args.get("query", "")
    limit = args.get("limit", 10)

    try:
        if mode == "docs":
            sources = args.get("sources", "")
            results = search_docs(query, sources=sources, limit=limit)
        elif mode == "api":
            service = args.get("service", "")
            method = args.get("method", "")
            results = search_api(query, service=service, method=method, limit=limit)
        else:
            # Default: code search
            collection = args.get("collection", None)
            include_extensions = args.get("include_extensions", "")
            exclude_patterns = args.get("exclude_patterns", "")
            must_contain = args.get("must_contain", "")
            must_contain_all = args.get("must_contain_all", True)

            results = search(
                query,
                limit=limit,
                collection=collection,
                include_extensions=include_extensions,
                exclude_patterns=exclude_patterns,
                must_contain=must_contain,
                must_contain_all=must_contain_all,
            )

        print(json.dumps(results, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
