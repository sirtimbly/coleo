# ADR-003: API Authentication Approach

**Status**: Accepted  
**Date**: 2024-01-15  
**Deciders**: Human (via implementation review)

## Context

The Observatory API needs authentication to prevent unauthorized access. Need to balance security with simplicity for Phase 1.

## Options

### Option 1: Simple API Key (Implemented)

Single shared secret in `X-API-Key` header.

```typescript
// Middleware
app.use(async (c, next) => {
  const key = c.req.header("X-API-Key");
  if (key !== config.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
```

**Pros**: Simple, fast to implement, good for local/dev use  
**Cons**: Single key for everyone, no user identity, no expiration

### Option 2: JWT Tokens (Future)

Issue tokens with claims and expiration.

**Pros**: User identity, expiration, refresh flow  
**Cons**: More complex, needs token management, key rotation

### Option 3: OAuth/OIDC (Future)

Full OAuth flow with identity provider.

**Pros**: Industry standard, SSO support, full user management  
**Cons**: Complex, requires IdP, overkill for single-user

## Decision

**Option 1 (API Key) for Phase 1** - Get things working fast

The API key approach is sufficient for:
- Local development
- Single-user deployment
- Homelab use

JWT (Option 2) can be added later when needed without breaking existing clients.

## Implementation

- API key configured via `OCTOPAI_API_KEY` env var or auto-generated on first run
- CLI passes key via `X-API-Key` header
- Web UI stores key in localStorage
- WebSocket authentication via first message with API key
- Health endpoint (`/api/health`) is public (no auth required)

## Future Considerations

When multi-user support is needed:
- Upgrade to JWT tokens (Option 2)
- Add user identity to requests
- Implement key rotation
- Add token refresh flow
