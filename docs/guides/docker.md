# Docker Setup

Run Octopai in containers for isolation and reproducibility.

## Quick Start

```bash
# Copy environment template
cp .env.example .env

# Edit with your API keys
nano .env

# Build and start
docker compose up -d

# Check status
docker compose ps
```

## Services

The Docker Compose stack includes:

| Service | Port | Description |
|---------|------|-------------|
| `octopai` | 2222 (SSH) | Main Octopai container |
| `gitea` | 3000 (HTTP), 2223 (SSH) | Git forge for collaboration |

## Connecting

### SSH Access

```bash
ssh -p 2222 octopai@localhost
# Password: octopai
```

Once connected:
```bash
# Check status
octopai status

# Start the brain
octopai brain run

# In another SSH session, spawn an arm
octopai tentacle spawn -n explorer --agent opencode
```

### Direct Execution

Without SSH:
```bash
docker exec -it octopai octopai status
docker exec -it octopai octopai brain run
```

## Environment Variables

Configure via `.env` file:

```bash
# Required: API keys for AI agents
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional: Mount your projects
PROJECTS_DIR=~/projects

# Optional: Use your SSH keys for git
SSH_KEYS_DIR=~/.ssh
```

## Volume Mounts

| Volume | Container Path | Purpose |
|--------|----------------|---------|
| `octopai-data` | `/home/octopai/.octopai` | Persistent state |
| `$PROJECTS_DIR` | `/home/octopai/projects` | Your projects |
| `$SSH_KEYS_DIR` | `/home/octopai/.ssh` | SSH keys (read-only) |

## Headless Mode

Inside the container, there's no display. Arms run in headless mode automatically:

- **With tmux:** Arms run in detached tmux sessions
- **Without tmux:** Arms run as background processes with logging

### Viewing Arm Output

```bash
# If using tmux
tmux list-sessions
tmux attach -t octopai_explorer

# If headless (background process)
tail -f ~/.octopai/logs/octopai_explorer.log
```

## Gitea Setup

Gitea provides a local Git forge for arm collaboration.

### First Run

1. Open http://localhost:3000
2. Complete the installation wizard
3. Create an admin account
4. Create a repository for your project

### Configure Octopai

```toml
# ~/.octopai/config.toml
[gitea]
url = "http://gitea:3000"
token = "your-access-token"
default_org = "octopai"
```

### Git SSH

For git operations via SSH:
```bash
git clone ssh://git@localhost:2223/octopai/my-project.git
```

## Custom Docker Build

### Building the Image

```bash
docker compose build octopai
```

### Dockerfile Customization

The Dockerfile installs:
- Bun runtime
- SSH server
- Git, curl, vim
- tmux (for arm sessions)
- Python (for some AI tools)

Add your own tools:
```dockerfile
# In Dockerfile
RUN apt-get update && apt-get install -y \
    your-custom-tool \
    && rm -rf /var/lib/apt/lists/*
```

## Production Deployment

### Security Hardening

1. **Change default password:**
```dockerfile
RUN echo 'octopai:your-secure-password' | chpasswd
```

2. **Use SSH keys instead of password:**
```dockerfile
RUN mkdir -p /home/octopai/.ssh \
    && echo "your-public-key" >> /home/octopai/.ssh/authorized_keys \
    && chmod 600 /home/octopai/.ssh/authorized_keys \
    && sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
```

3. **Generate unique API key:**
```bash
openssl rand -base64 32
```

### Resource Limits

```yaml
# docker-compose.yml
services:
  octopai:
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G
        reservations:
          cpus: '1'
          memory: 2G
```

### Health Checks

```yaml
services:
  octopai:
    healthcheck:
      test: ["CMD", "octopai", "status"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs octopai

# Common issues:
# - Port 2222 already in use
# - Missing .env file
# - Invalid API keys
```

### Can't SSH In

```bash
# Check SSH is running
docker exec octopai ps aux | grep sshd

# Check port mapping
docker compose port octopai 22
```

### Gitea Not Healthy

```bash
# Check Gitea logs
docker compose logs gitea

# Gitea needs time to initialize on first run
# Wait for health check to pass (may take 30-60 seconds)
```

### Arms Not Spawning

```bash
# Check if tmux is available
docker exec octopai which tmux

# Try explicit headless mode
docker exec octopai octopai tentacle spawn -n test --headless
```

## Updating

```bash
# Pull latest changes
git pull

# Rebuild
docker compose build

# Restart with new image
docker compose up -d
```

## Cleanup

```bash
# Stop containers
docker compose down

# Remove volumes (WARNING: deletes all data)
docker compose down -v

# Remove images
docker compose down --rmi all
```
