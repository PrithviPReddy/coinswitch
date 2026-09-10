# syntax=docker/dockerfile:1
# CoinSwitch - Next.js 16 + Prisma + Postgres
#
#   docker compose up --build   ->  http://localhost:3000

FROM node:22-slim AS base
# Debian rather than alpine: the Prisma query engine is glibc-linked and will
# not run against musl. openssl is what the engine links against at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1


FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts


FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prisma generate is mandatory before next build: schema.prisma writes the
# client to app/generated/prisma, that directory is not committed, and
# app/db/index.ts imports from it. Skipping this fails the build outright.
# Generate never opens a connection, so the throwaway URL is correct here -
# a real one would be readable in the image history.
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate

# layout.tsx pulls Geist and Source Serif through next/font/google, so the
# build reaches fonts.googleapis.com. A network-isolated builder fails here.
RUN npm run build


FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Fresh production install rather than dragging the builder's node_modules,
# which carries eslint, tailwind and typescript. --ignore-scripts because
# the postinstall prisma generate has no schema at this point in the stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder --chown=node:node /app/.next            ./.next
COPY --from=builder --chown=node:node /app/public           ./public
COPY --from=builder --chown=node:node /app/app/generated    ./app/generated
COPY --from=builder --chown=node:node /app/prisma           ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts

USER node
EXPOSE 3000

# Migrations run in the compose `migrate` service, not here: several replicas
# starting at once would race to migrate the same database.
CMD ["npm", "run", "start"]
