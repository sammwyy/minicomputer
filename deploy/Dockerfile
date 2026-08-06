FROM oven/bun:1.3.3

WORKDIR /app
ENV NODE_ENV=production
ENV MINICOMPUTER_PORT=8080
ENV MINICOMPUTER_BACKEND_ENDPOINT=/var/run/docker.sock

COPY package.json bun.lock ./
COPY orchestrator/package.json orchestrator/tsconfig.json ./orchestrator/
COPY clients/node/package.json clients/node/tsconfig.json clients/node/tsconfig.build.json ./clients/node/
RUN bun install --frozen-lockfile

COPY orchestrator ./orchestrator
COPY clients/node ./clients/node

EXPOSE 8080
CMD ["bun", "run", "orchestrator/src/index.ts"]
