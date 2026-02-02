# Docker Setup

Run Coleo in containers for isolation and reproducibility.

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
| `coleo` | 2222 (SSH) | Main Coleo container |
| `gitea` | 3000 (HTTP), 2223 (SSH) | Git forge for collaboration |

## Connecting

### SSH Access

```bash
ssh -p 2222 coleo@localhost
# Password: coleo
```

Once connected:
```bash
# Check status
coleo status

# Start the brain
coleo brain run

# In another SSH session, spawn an arm
coleo arm spawn -n explorer --agent opencode
```

### Direct Execution

Without SSH:
```bash
docker exec -it coleo coleo status
docker exec -it coleo coleo brain run
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
| `coleo-data` | `/home/coleo/.coleo` | Persistent state |
| `$PROJECTS_DIR` | `/home/coleo/projects` | Your projects |
| `$SSH_KEYS_DIR` | `/home/coleo/.ssh` | SSH keys (read-only) |

## Headless Mode

Inside the container, there's no display. Arms run in headless mode automatically:

- **With tmux:** Arms run in detached tmux sessions
- **Without tmux:** Arms run as background processes with logging

### Viewing Arm Output

```bash
# If using tmux
tmux list-sessions
tmux attach -t coleo_explorer

# If headless (background process)
tail -f ~/.coleo/logs/coleo_explorer.log
```

## Gitea Setup

Gitea provides a local Git forge for arm collaboration.

### First Run

1. Open http://localhost:3000
2. Complete the installation wizard
3. Create an admin account
4. Create a repository for your project

### Configure Coleo

```toml
# ~/.coleo/config.toml
[gitea]
url = "http://gitea:3000"
token = "your-access-token"
default_org = "coleo"
```

### Git SSH

For git operations via SSH:
```bash
git clone ssh://git@localhost:2223/coleo/my-project.git
```

## Custom Docker Build

### Building the Image

```bash
docker compose build coleo
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
RUN echo 'coleo:your-secure-password' | chpasswd
```

2. **Use SSH keys instead of password:**
```dockerfile
RUN mkdir -p /home/coleo/.ssh \
    && echo "your-public-key" >> /home/coleo/.ssh/authorized_keys \
    && chmod 600 /home/coleo/.ssh/authorized_keys \
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
  coleo:
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
      test: ["CMD", "coleo", "status"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs coleo

# Common issues:
# - Port 2222 already in use
# - Missing .env file
# - Invalid API keys
```

### Can't SSH In

```bash
# Check SSH is running
docker exec coleo ps aux | grep sshd

# Check port mapping
docker compose port coleo 22
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
docker exec coleo which tmux

# Try explicit headless mode
docker exec -it coleo coleo arm spawn -n test --headless
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
