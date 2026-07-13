FROM node:22-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile \
  && corepack pnpm build:runner-package

ENTRYPOINT ["node", "apps/runner/dist/cli.js"]
CMD ["mcp", "serve", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8766", "--config", "/config/synapsor.runner.json"]
