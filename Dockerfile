# Octopai Docker Image
#
# Provides a complete environment for running Octopai brain and tentacles
# with SSH access for interactive sessions.

FROM oven/bun:1.3-debian AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# ============================================
# Runtime image
# ============================================
FROM oven/bun:1.3-debian

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    openssh-server \
    git \
    curl \
    vim \
    less \
    sudo \
    # For terminal-based agents
    tmux \
    # Python for some AI tools
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Configure SSH
RUN mkdir -p /var/run/sshd \
    && echo 'PermitRootLogin no' >> /etc/ssh/sshd_config \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'X11Forwarding no' >> /etc/ssh/sshd_config \
    && ssh-keygen -A

# Create octopai user
RUN useradd -m -s /bin/bash -G sudo octopai \
    && echo 'octopai:octopai' | chpasswd \
    && echo 'octopai ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Set up octopai home
WORKDIR /home/octopai

# Copy built application
COPY --from=builder /app /home/octopai/octopai
RUN chown -R octopai:octopai /home/octopai/octopai

# Create convenience symlink for CLI
RUN ln -s /home/octopai/octopai/bin/octopai.ts /usr/local/bin/octopai-cli

# Create wrapper script that uses bun
RUN echo '#!/bin/bash\nbun /home/octopai/octopai/src/cli/index.ts "$@"' > /usr/local/bin/octopai \
    && chmod +x /usr/local/bin/octopai

# Install OpenCode (if available) - commented out until we have install method
# RUN curl -fsSL https://opencode.ai/install.sh | bash

# Create projects directory
RUN mkdir -p /home/octopai/projects \
    && chown octopai:octopai /home/octopai/projects

# Initialize octopai for the user
USER octopai
RUN /usr/local/bin/octopai init

# Add helpful aliases to bashrc
RUN echo '\n\
# Octopai aliases\n\
alias brain="octopai brain run"\n\
alias status="octopai status"\n\
alias inbox="octopai mail inbox"\n\
alias tasks="octopai status"\n\
\n\
# Show status on login\n\
echo ""\n\
echo "🐙 Octopai Environment"\n\
echo ""\n\
octopai status 2>/dev/null || echo "Run: octopai init"\n\
echo ""\n\
echo "Commands:"\n\
echo "  octopai brain run     - Start the brain"\n\
echo "  octopai tentacle spawn -n NAME --agent opencode"\n\
echo "  octopai mail send \"task description\""\n\
echo "  octopai status        - Show status"\n\
echo ""\n\
' >> /home/octopai/.bashrc

# Switch back to root for sshd
USER root

# Expose SSH port
EXPOSE 22

# Start SSH server
CMD ["/usr/sbin/sshd", "-D"]
