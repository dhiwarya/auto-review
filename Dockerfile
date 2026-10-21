# Auto Reviewer with everything it runs: git, ripgrep, and the Claude Code and Codex CLIs.
# Start it with `docker compose up -d`; see "Run in Docker" in the README.

FROM node:26.8.1-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26.8.1-bookworm-slim
# The same versions as on the machine this was set up on. Bump them to update the CLIs.
ARG CLAUDE_CODE_VERSION=2.1.304
ARG CODEX_VERSION=0.163.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep tzdata \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=web /app/web/dist ./web/dist

# Sign-ins live in volumes so they survive rebuilds. The CLIs are pinned, so they don't
# update themselves.
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=4477 \
  DATA_DIR=/app/data \
  CLAUDE_CONFIG_DIR=/home/node/.claude \
  CODEX_HOME=/home/node/.codex \
  DISABLE_AUTOUPDATER=1
RUN mkdir -p /app/data /home/node/.claude /home/node/.codex && chown -R node:node /app/data /home/node
USER node
# The data folder is mounted from the host, so its files can belong to another user ID.
RUN git config --global --add safe.directory '*'

EXPOSE 4477
CMD ["node", "src/index.ts"]
