FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile \
  && corepack pnpm build:runner-package \
  && chmod +x examples/runner-fleet/start-tls-runner.sh

ENTRYPOINT ["examples/runner-fleet/start-tls-runner.sh"]
CMD ["mcp", "serve", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8766", "--config", "/config/synapsor.runner.json"]
