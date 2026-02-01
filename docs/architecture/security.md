# Security Considerations

Security is critical for a system that orchestrates AI agents with access to code and deployments.

## Authentication & Authorization

### API Authentication

All API access requires a shared secret:

```http
X-API-Key: your-shared-secret-here
```

**Generating a secure key:**
```bash
openssl rand -base64 32
```

**Storing the key:**
```bash
# In .env file (never commit!)
OCTOPAI_API_KEY=your-generated-key

# Or in config
# ~/.octopai/config.toml
[observatory]
api_key = "your-generated-key"
```

### Future: Enhanced Auth

For production deployments, consider:
- Per-user API keys with scopes
- OAuth/OIDC integration
- mTLS for service-to-service auth
- Session-based auth for web UI

## Arm Sandboxing

Arms are AI agents with significant capabilities. They must be constrained.

### Execution Environment

| Mode | Isolation | Use Case |
|------|-----------|----------|
| Docker container | High | Production, untrusted agents |
| Local process | Low | Development, trusted agents |
| VM | Very High | Multi-tenant deployments |

### Capability Restrictions

Arms should be restricted from:

| Capability | Default | Notes |
|------------|---------|-------|
| Network access | Whitelisted domains only | Prevent exfiltration |
| File system | Project directory only | Prevent system access |
| Process spawning | Restricted | Only approved tools |
| Env var access | Filtered | No secrets visible |

### Docker Example

```dockerfile
# Arm container with restrictions
FROM octopai-arm-base:latest

# Non-root user
USER octopai

# Read-only filesystem (except workspace)
# Mounted at runtime with --read-only

# No network by default
# Enabled per-arm with specific allowed hosts

# Resource limits
# Set via docker run --memory, --cpus
```

### Process Limits (cgroups)

```yaml
# docker-compose.yml
services:
  arm-ui:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '0.5'
          memory: 1G
```

## Secret Management

Secrets must never be exposed to arms or logged.

### Secret Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    SECRET FLOW                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Secret Manager (Vault, AWS SM, etc.)                        │
│         │                                                    │
│         │ (encrypted, at deploy time only)                   │
│         ▼                                                    │
│  Brain/Observatory (fetches, uses, never logs)               │
│         │                                                    │
│         │ (reference only, never value)                      │
│         ▼                                                    │
│  Arms (see secret names, not values)                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Environment Variables

Arms receive filtered environment:

```typescript
const BLOCKED_ENV_PATTERNS = [
  /API_KEY/i,
  /SECRET/i,
  /PASSWORD/i,
  /TOKEN/i,
  /PRIVATE/i,
  /CREDENTIAL/i,
];

function filterEnvForArm(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => 
      !BLOCKED_ENV_PATTERNS.some(p => p.test(key))
    )
  );
}
```

### Secrets in Proposals

The proposal system must sanitize secrets:

```typescript
function sanitizeProposalContent(content: string): string {
  // Redact anything that looks like a secret
  return content
    .replace(/([A-Za-z_]+(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z_]*)\s*[=:]\s*["']?[^\s"']+["']?/gi, 
             '$1=<REDACTED>')
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, 
             'Bearer <REDACTED>');
}
```

## Destructive Command Detection

The brain monitors for dangerous commands and blocks them.

### Blocked Patterns

```typescript
const DESTRUCTIVE_PATTERNS = [
  // Filesystem destruction
  /rm\s+(-rf?|--recursive)\s+\//,
  /rm\s+(-rf?|--recursive)\s+~\//,
  /rm\s+(-rf?|--recursive)\s+\.\.\//,
  /find\s+.*-delete/,
  
  // Git destruction
  /git\s+push\s+.*--force\s+.*main/,
  /git\s+push\s+.*--force\s+.*master/,
  /git\s+reset\s+--hard\s+HEAD~[0-9]+/,
  
  // Database destruction
  /DROP\s+(DATABASE|TABLE|SCHEMA)/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*(;|$)/i,  // DELETE without WHERE
  
  // System commands
  /chmod\s+777/,
  /chmod\s+-R\s+777/,
  /:(){ :\|:& };:/,  // Fork bomb
  
  // Credential exposure
  /curl\s+.*\$\{?[A-Z_]*KEY/,
  /echo\s+\$\{?[A-Z_]*SECRET/,
];
```

### Secret Leak Detection

Arms must never leak secrets in commits, logs, or network requests.

```typescript
interface SecretLeakDetector {
  patterns: SecretPattern[];
  actions: ("block" | "warn" | "prompt")[];
  allowlist: string[];           // Known-safe strings (e.g., example values)
}

const SECRET_PATTERNS: SecretPattern[] = [
  // API Keys
  { name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub Token", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "GitLab Token", pattern: /glpat-[a-zA-Z0-9\-]{20}/ },
  { name: "Slack Token", pattern: /xox[baprs]-[a-zA-Z0-9\-]+/ },
  { name: "OpenAI Key", pattern: /sk-[a-zA-Z0-9]{48}/ },
  { name: "Anthropic Key", pattern: /sk-ant-[a-zA-Z0-9\-]+/ },
  { name: "Stripe Key", pattern: /sk_live_[a-zA-Z0-9]+/ },
  
  // Generic secrets
  { name: "Private Key", pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Password in URL", pattern: /:\/\/[^:]+:[^@]+@/ },
  { name: "Base64 Secret", pattern: /(?:password|secret|token|key)\s*[:=]\s*["']?[A-Za-z0-9+/]{32,}={0,2}["']?/i },
  
  // Environment variable patterns
  { name: "Env Secret", pattern: /^[A-Z_]*(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)[A-Z_]*\s*=\s*.+/m },
];
```

### Secret in Commit Detection

Before any git commit, the brain scans for secrets:

```typescript
interface CommitSecretScan {
  files: string[];
  secretsFound: DetectedSecret[];
  action: "block" | "prompt_user";
}

interface DetectedSecret {
  file: string;
  line: number;
  pattern: string;
  snippet: string;            // Redacted snippet for context
  confidence: "high" | "medium" | "low";
}

// If secrets found:
// 1. Block the commit
// 2. Notify the arm: "Potential secret detected in {file}:{line}"
// 3. Prompt human: "Allow this string to be committed? [y/N]"
```

### Data Exfiltration Monitoring

Monitor for attempts to send data outside the allowed network:

```typescript
interface ExfiltrationDetector {
  // Known exfiltration targets
  blockedDomains: string[];
  
  // Behavioral patterns
  rules: ExfiltrationRule[];
}

const EXFILTRATION_RULES: ExfiltrationRule[] = [
  {
    name: "Pastebin upload",
    pattern: /curl.*pastebin\.com/i,
    action: "block",
    severity: "critical",
  },
  {
    name: "GitHub Gist creation",
    pattern: /curl.*api\.github\.com\/gists/,
    action: "prompt",
    severity: "high",
  },
  {
    name: "Large data to unknown domain",
    condition: (req) => 
      req.bodySize > 10000 && !ALLOWED_DOMAINS.includes(req.host),
    action: "block",
    severity: "critical",
  },
  {
    name: "Source code in request body",
    condition: (req) => 
      containsSourceCode(req.body) && !ALLOWED_DOMAINS.includes(req.host),
    action: "block",
    severity: "critical",
  },
  {
    name: "Encoded data transfer",
    pattern: /curl.*--data.*base64/,
    action: "prompt",
    severity: "medium",
  },
];

const EXFILTRATION_DOMAINS = [
  // Pastebins
  "pastebin.com",
  "paste.ee",
  "hastebin.com",
  "dpaste.org",
  "ghostbin.com",
  
  // File sharing
  "transfer.sh",
  "file.io",
  "0x0.st",
  
  // Webhook services (could leak data)
  "webhook.site",
  "requestbin.com",
  "pipedream.net",
];
```

### Exfiltration Response

```
┌─────────────────────────────────────────────────────────────┐
│                EXFILTRATION DETECTION FLOW                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Arm attempts network request                             │
│     │                                                        │
│  2. Brain intercepts and scans:                              │
│     ├── Is destination in blocked domains?                   │
│     ├── Is payload suspiciously large?                       │
│     ├── Does payload contain source code patterns?           │
│     └── Does payload contain detected secrets?               │
│                                                              │
│  3. If suspicious:                                           │
│     ├── BLOCK request immediately                            │
│     ├── PAUSE arm                                            │
│     ├── LOG full details (redacting actual secrets)          │
│     ├── NOTIFY human with context                            │
│     └── REPUTATION penalty (-25 for exfiltration attempt)    │
│                                                              │
│  4. Human reviews and decides:                               │
│     ├── False positive → Resume arm, adjust rules            │
│     ├── Suspicious → Investigate further                     │
│     └── Malicious → Kill arm, review all its actions         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Response to Detection

| Severity | Detection | Response |
|----------|-----------|----------|
| Critical | Fork bomb, rm -rf /, exfiltration | KILL arm immediately |
| High | Force push to main, secret in commit | PAUSE arm, notify human |
| Medium | DELETE without WHERE, encoded transfer | WARN, require confirmation |
| Low | chmod 777 | WARN, log |

## Audit Logging

All actions are logged for auditing.

### Log Format

```typescript
interface AuditLog {
  timestamp: Date;
  actor: string;           // Arm ID, "brain", or "human"
  action: string;          // What was done
  target?: string;         // What was affected
  details?: unknown;       // Additional context
  result: "success" | "failure" | "blocked";
  reason?: string;         // If blocked, why
}
```

### Logged Events

| Event | Actor | Details |
|-------|-------|---------|
| Arm spawned | human | Arm config |
| Arm killed | brain/human | Reason |
| File claimed | arm | Path |
| File modified | arm | Path, diff summary |
| Proposal created | arm | Proposal summary |
| Deployment started | arm | Environment, ref |
| Human approval | human | Decision, reason |
| Misbehavior detected | brain | Pattern matched |

### Log Retention

```typescript
interface AuditConfig {
  retentionDays: number;       // How long to keep logs
  sensitiveRetentionDays: number;  // Shorter for sensitive logs
  externalSink?: string;       // Send to external logging system
}
```

## Network Security

### Allowed Domains

Arms can only access whitelisted domains:

```typescript
const ALLOWED_DOMAINS = [
  // Package registries
  "registry.npmjs.org",
  "pypi.org",
  
  // Documentation
  "docs.github.com",
  "developer.mozilla.org",
  "react.dev",
  
  // Internal
  "localhost",
  "gitea",  // Docker network name
  
  // Custom (configured per project)
  ...config.allowedDomains,
];
```

### Network Policies (Kubernetes)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: octopai-arm-policy
spec:
  podSelector:
    matchLabels:
      app: octopai-arm
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              name: octopai
      ports:
        - port: 8080  # Brain API
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443   # HTTPS only
```

## Incident Response

When security issues are detected:

### Immediate Actions

1. **Isolate**: Pause/kill affected arms
2. **Preserve**: Capture logs and state
3. **Notify**: Push notification to human
4. **Prevent**: Block similar actions

### Incident Report

```typescript
interface SecurityIncident {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  type: string;
  affectedArms: string[];
  description: string;
  detectedAt: Date;
  resolvedAt?: Date;
  actions: string[];           // What was done
  preventionMeasures: string[]; // What will prevent recurrence
}
```

## Container Orchestration (Homelab)

For running Coleo on a homelab cluster, Docker Swarm provides a simpler alternative to Kubernetes.

### Docker Swarm Setup

```yaml
# docker-compose.swarm.yml
version: "3.8"

services:
  brain:
    image: octopai/brain:latest
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
    networks:
      - octopai-net

  observatory:
    image: octopai/observatory:latest
    deploy:
      replicas: 2
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.observatory.rule=Host(`coleo.local`)"
    networks:
      - octopai-net

  arm-pool:
    image: octopai/arm:latest
    deploy:
      replicas: 4
      resources:
        limits:
          cpus: '2'
          memory: 4G
    networks:
      - octopai-net

networks:
  octopai-net:
    driver: overlay
```

### Swarmpit for Management

[Swarmpit](https://swarmpit.io) provides a web UI for Docker Swarm management:

```bash
# Deploy Swarmpit to your swarm
docker stack deploy -c swarmpit.yml swarmpit
```

**Swarmpit provides:**
- Visual service management
- Real-time resource monitoring
- Log aggregation
- One-click scaling
- Secret management UI

### Homelab Deployment Notes

| Consideration | Recommendation |
|---------------|----------------|
| Minimum nodes | 3 (1 manager, 2 workers) |
| Storage | Shared NFS or GlusterFS for persistent data |
| Networking | Overlay network with encryption |
| Load balancer | Traefik (auto-configured with Swarm) |
| Secrets | Docker Swarm secrets (encrypted at rest) |
| Monitoring | Swarmpit + Prometheus stack |

### Self-Configuration (Future)

Arms could potentially manage the swarm:

```typescript
interface SwarmMCP {
  "swarm.scale": (params: {
    service: string;
    replicas: number;
  }) => void;
  
  "swarm.logs": (params: {
    service: string;
    since: string;
  }) => LogEntry[];
  
  "swarm.health": () => SwarmHealth;
}
```

**Note**: This is lower priority. Focus on core functionality first before self-orchestration.

## Security Checklist

Before deploying Coleo:

- [ ] Generated strong API key
- [ ] API key stored securely (not in git)
- [ ] Arms running in containers with resource limits
- [ ] Network egress restricted to allowed domains
- [ ] Secrets stored in external secret manager
- [ ] Audit logging enabled
- [ ] Destructive command patterns reviewed
- [ ] Push notifications configured for security alerts
- [ ] Regular log review scheduled
- [ ] Incident response plan documented
