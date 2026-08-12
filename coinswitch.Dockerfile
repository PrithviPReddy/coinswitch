# syntax=docker/dockerfile:1
# =============================================================================
# Solana Token Swap Platform (repo: coinswitch) — Next.js 16 + Prisma + Postgres
#
# SAVE AS:  <coinswitch repo root>/Dockerfile
# Also add the .dockerignore (see README).
#
# Build & run:
#   docker build -t solana-swap .
#   docker run --rm -p 3000:3000 --env-file .env solana-swap
# =============================================================================


# -----------------------------------------------------------------------------
# base
# -----------------------------------------------------------------------------
# Debian slim rather than alpine: prisma/schema.prisma sets no binaryTargets, so
# the generated query engine is debian-openssl-3.0.x and is glibc-linked. It
# will not run on alpine's musl. openssl is installed because the engine links
# against libssl at runtime.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1


# -----------------------------------------------------------------------------
# deps
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci


# -----------------------------------------------------------------------------
# builder
# -----------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `prisma generate` is MANDATORY before `next build`, not optional cleanup.
# schema.prisma sets  output = "../app/generated/prisma"  and app/db/index.ts
# imports PrismaClient from "@/app/generated/prisma". That directory is not
# committed, so without this step the build dies with module-not-found on
# ./app/db/index.ts.
#
# prisma.config.ts reads process.env["DATABASE_URL"]. Generate never opens a
# connection, so a throwaway value is correct — never pass a real one, build
# args are readable in the image history.
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate

# app/layout.tsx pulls Geist via next/font/google, so the build fetches from
# fonts.googleapis.com. This build will fail on a network-isolated builder.
RUN npm run build


# -----------------------------------------------------------------------------
# runner
# -----------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Fresh production-only install rather than carrying the builder's node_modules,
# which holds eslint, tailwind, typescript and the rest of devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# `next start` reads the serialised config from .next/required-server-files.json
# rather than re-parsing next.config.ts, which is why dropping devDependencies
# (and typescript with them) is safe here.
COPY --from=builder --chown=node:node /app/.next            ./.next
COPY --from=builder --chown=node:node /app/public           ./public
COPY --from=builder --chown=node:node /app/app/generated    ./app/generated
COPY --from=builder --chown=node:node /app/prisma           ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts

USER node
EXPOSE 3000

# Runtime env expected via --env-file: DATABASE_URL, NEXTAUTH_SECRET,
# NEXTAUTH_URL, and whichever Solana RPC endpoint you use.
#
# Migrations are deliberately not run here. `prisma migrate deploy` belongs in a
# deploy step that runs once — if several replicas start together they will all
# race to migrate the same database.
CMD ["npm", "run", "start"]
