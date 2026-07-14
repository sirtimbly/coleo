# Coleo Docker Image
#
# Provides a complete environment for running Coleo brain and arms
# with SSH access for interactive sessions.

FROM oven/bun:1.3-debian AS builder

WORKDIR /app

# Copy workspace manifests required for dependency resolution
COPY package.json bun.lock ./
COPY src/web/package.json ./src/web/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build the production CLI and web UI bundle used by the hosted image.
RUN bun run build

# ============================================
# Runtime image
# ============================================
FROM oven/bun:1.3-debian

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    bash \
    ca-certificates \
    openssh-server \
    git \
    curl \
    wget \
    gnupg \
    jq \
    ripgrep \
    procps \
    build-essential \
    nodejs \
    npm \
    vim \
    less \
    sudo \
    # For terminal-based agents
    tmux \
    # Python for some AI tools
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install the current OpenCode CLI for headless opencode-api arms.
# OpenCode documents npm/bun/curl install paths; npm gives a simple,
# reproducible PATH location in this Debian-based runtime image.
RUN npm install -g opencode-ai@latest \
    && opencode --version

# Configure SSH
RUN mkdir -p /var/run/sshd \
    && echo 'PermitRootLogin no' >> /etc/ssh/sshd_config \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'X11Forwarding no' >> /etc/ssh/sshd_config \
    && ssh-keygen -A

# Create coleo user
RUN useradd -m -s /bin/bash -G sudo coleo \
    && echo 'coleo:coleo' | chpasswd \
    && echo 'coleo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Set up coleo home
WORKDIR /home/coleo

# Copy built application
COPY --from=builder /app /home/coleo/coleo
RUN chown -R coleo:coleo /home/coleo/coleo

# Runtime bootstrap for hosted API + web UI + brain + OpenCode arm agent.
COPY docker/hosting-entrypoint.sh /usr/local/bin/coleo-hosting-entrypoint
RUN chmod 0755 /usr/local/bin/coleo-hosting-entrypoint

# Create convenience symlink for CLI (if present)
RUN ln -s /home/coleo/coleo/bin/coleo.ts /usr/local/bin/coleo-cli || true

# Create wrapper script that uses bun
RUN echo '#!/bin/bash\nbun /home/coleo/coleo/src/cli/index.ts "$@"' > /usr/local/bin/coleo \
    && chmod +x /usr/local/bin/coleo

# Create projects directory
RUN mkdir -p /home/coleo/projects \
    && chown coleo:coleo /home/coleo/projects

# Run as unprivileged user by default for interactive shells.
USER coleo

# Add helpful aliases to bashrc
RUN echo '\n\
# Coleo aliases\n\
alias brain="coleo brain run"\n\
alias status="coleo status"\n\
alias inbox="coleo mail inbox"\n\
alias tasks="coleo status"\n\
\n\
# Show status on login\n\
echo ""\n\
echo "🐙 Coleo Environment"\n\
echo ""\n\
coleo status 2>/dev/null || echo "Run: coleo init"\n\
echo ""\n\
echo "Commands:"\n\
echo "  coleo brain run     - Start the brain"\n\
echo "  coleo arm spawn -n NAME --agent opencode"\n\
echo "  coleo mail send \"task description\""\n\
echo "  coleo status        - Show status"\n\
echo ""\n\
' >> /home/coleo/.bashrc

# Switch back to root for sshd
USER root

# Expose API, web UI, and SSH ports
EXPOSE 8080 5173 22

ENTRYPOINT ["/usr/local/bin/coleo-hosting-entrypoint"]
