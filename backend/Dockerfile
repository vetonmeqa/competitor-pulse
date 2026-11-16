# One image for the API, the worker and the migration step. Compose picks the command.

# --- Build: compile TypeScript to JavaScript -------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Dependencies first, so this layer is reused until package files change.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Runtime: production dependencies and the compiled code only ------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The SQL migrations, applied by `node dist/db/migrate.js`.
COPY drizzle ./drizzle
# Do not run as root.
USER node
EXPOSE 3000
CMD ["node", "dist/main-api.js"]
