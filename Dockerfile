FROM oven/bun:1.3.5
LABEL io.modelcontextprotocol.server.name="io.github.timescale/pg-aiguide"

WORKDIR /app

COPY package.json bun.lock ./
RUN bun ci --production

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY skills.yaml ./
COPY migrations ./migrations

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts", "http"]
EXPOSE 3001