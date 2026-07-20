# Stage 1: build the React client
FROM node:24-alpine AS client
WORKDIR /build
COPY client/package.json client/package-lock.json client/.npmrc ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: server dependencies (@vscode/sqlite3 compiles natively; the
# postinstall patch-package run needs patches/)
FROM node:24-alpine AS server-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev

# Stage 3: the Fastify server
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=server-deps /app/node_modules ./node_modules
COPY src ./src
COPY --from=client /build/dist ./client/dist
# Default SQL_URI lands the pool database here; mount a volume to persist it.
RUN mkdir -p /var/lib/ozwell-studio-launcher && chown node:node /var/lib/ozwell-studio-launcher
ENV NODE_ENV=production STATE_DIRECTORY=/var/lib/ozwell-studio-launcher
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
