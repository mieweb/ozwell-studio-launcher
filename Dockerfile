# Stage 1: build the React client
FROM node:24-alpine AS client
WORKDIR /build
COPY client/package.json client/package-lock.json client/.npmrc ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: the Fastify server
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=client /build/dist ./client/dist
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
