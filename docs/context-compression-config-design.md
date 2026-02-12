# Context Compression Configuration Options - Design Document

## Task: phase27c-a23b40

## Current State

Context compression is already implemented in the codebase:
- Database table: `context_compressions`
- MCP tools: `report_context_compression`, `check_context_budget`
- Types: `ContextCompression` interface
- Config: `contextBudget` in defaults

## Missing: Configuration Options

Currently, compression behavior is hardcoded. We need configurable options for:

## Proposed Configuration Schema

### 1. Add to ColeoConfig Interface

```typescript
export interface ColeoConfig {
  // ... existing config
  
  compression: {
    // Enable/disable automatic compression
    enabled: boolean;
    
    // Compression thresholds (% of budget)
    thresholds: {
      warning: number;      // Default: 0.80 (80%)
      softLimit: number;    // Default: 0.95 (95%)
      hardLimit: number;    // Default: 1.00 (100%)
    };
    
    // Compression strategy
    strategy: "aggressive" | "balanced" | "conservative";
    
    // Content removal priority (order matters)
    removalPriority: Array<
      | "history"      // Old conversation history
      | "artifacts"    // File contents, code snippets
      | "notes"        // Shared notes between arms
      | "tools"        // Tool descriptions and schemas
      | "context"      // General context
    >;
    
    // Minimum tokens to keep after compression
    minTokensAfterCompression: number;
    
    // Auto-compress on threshold
    autoCompress: boolean;
    
    // Notify on compression
    notifyOnCompression: boolean;
  };
}
```

### 2. Default Configuration

```typescript
compression: {
  enabled: true,
  thresholds: {
    warning: 0.80,      // Warn at 80% budget
    softLimit: 0.95,    // Soft compression at 95%
    hardLimit: 1.00,    // Hard compression at 100%
  },
  strategy: "balanced",
  removalPriority: [
    "history",      // Remove oldest history first
    "artifacts",    // Then large artifacts
    "notes",        // Then shared notes
    "tools",        // Then tool schemas
    "context",      // Finally general context
  ],
  minTokensAfterCompression: 10000,
  autoCompress: true,
  notifyOnCompression: true,
}
```

### 3. TOML Configuration

```toml
[compression]
enabled = true
strategy = "balanced"
auto_compress = true
notify_on_compression = true
min_tokens_after_compression = 10000

[compression.thresholds]
warning = 0.80
soft_limit = 0.95
hard_limit = 1.00

[compression.removal_priority]
priority = ["history", "artifacts", "notes", "tools", "context"]
```

## Implementation Plan

### Phase 1: Types and Configuration (1 hour)
- [ ] Add CompressionConfig interface to types
- [ ] Update ColeoConfig interface
- [ ] Update DEFAULT_CONFIG
- [ ] Update TomlConfig interface
- [ ] Add validation functions

### Phase 2: Configuration Loader (30 min)
- [ ] Update config loader to parse compression settings
- [ ] Add compression section to TOML writer
- [ ] Add environment variable support

### Phase 3: Compression Logic (1 hour)
- [ ] Update compression algorithm to use config
- [ ] Implement strategy modes
- [ ] Add threshold checking
- [ ] Update MCP tools to respect config

### Phase 4: API and Web UI (1 hour)
- [ ] Add compression config endpoints
- [ ] Create compression settings page
- [ ] Add real-time threshold indicators

### Phase 5: Testing (30 min)
- [ ] Unit tests for configuration validation
- [ ] Integration tests for compression strategies
- [ ] Test different threshold scenarios

## Validation Rules

1. **thresholds.warning**: 0.0 - 1.0, must be < softLimit
2. **thresholds.softLimit**: 0.0 - 1.0, must be < hardLimit
3. **thresholds.hardLimit**: 0.0 - 1.0, must be > softLimit
4. **strategy**: Must be one of ["aggressive", "balanced", "conservative"]
5. **removalPriority**: Must contain all 5 types, no duplicates
6. **minTokensAfterCompression**: > 1000, < contextBudget

## Strategy Definitions

### Aggressive
- Compress at 70% budget
- Remove up to 60% of content
- Prioritize speed over retention

### Balanced (Default)
- Compress at 80% budget
- Remove up to 40% of content
- Balance between speed and retention

### Conservative
- Compress at 90% budget
- Remove up to 20% of content
- Prioritize retention over speed

## Questions/Clarifications Needed

1. Should compression settings be per-arm or global?
2. Should we support different strategies per task type?
3. Do we need a UI for real-time compression adjustment?
4. Should we persist compression history in config?

## Next Steps

1. Review and approve design
2. Implement Phase 1 (types)
3. Implement Phase 2 (loader)
4. Implement Phase 3 (logic)
5. Implement Phase 4 (API/UI)
6. Implement Phase 5 (tests)
7. Documentation and PR

**Total Estimated Time: 4 hours**
