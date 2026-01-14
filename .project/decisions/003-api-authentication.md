# ADR-003: API Authentication Approach

**Status**: Proposed  
**Date**: 2024-01-15  
**Deciders**: Pending human decision

## Context

The Observatory API needs authentication to prevent unauthorized access. Need to balance security with simplicity for Phase 1.

## Options

### Option 1: Simple API Key (Recommended for Phase 1)

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

### Option 2: JWT Tokens

Issue tokens with claims and expiration.

**Pros**: User identity, expiration, refresh flow  
**Cons**: More complex, needs token management, key rotation

### Option 3: OAuth/OIDC

Full OAuth flow with identity provider.

**Pros**: Industry standard, SSO support, full user management  
**Cons**: Complex, requires IdP, overkill for single-user

## Recommendation

**Phase 1**: Option 1 (API Key) - Get things working fast  
**Phase 5+**: Upgrade to Option 2 (JWT) for multi-user support

The API key approach is sufficient for:
- Local development
- Single-user deployment
- Homelab use

JWT can be added later when needed without breaking existing clients (just add new auth method).

## Decision

**Awaiting human input.**

Questions for human:
1. Is API key sufficient for Phase 1?
2. Expected user count for initial deployments?
3. Any SSO requirements to plan for?

## References

- [Hono authentication patterns](https://hono.dev/guides/auth)
