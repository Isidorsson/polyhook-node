# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /src/node_modules ./node_modules
COPY --from=build --chown=app:app /src/dist ./dist
COPY --from=build --chown=app:app /src/package.json ./
USER app
EXPOSE 8080
ENV DB_PATH=/data/polyhook.db NODE_ENV=production
CMD ["node", "dist/server.js"]
