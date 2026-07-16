FROM node:22.12.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.mjs ./
COPY public ./public
COPY src ./src
COPY shared ./shared
COPY domain ./domain
COPY server ./server
COPY contest-server.mjs ./
RUN npm run build

FROM node:22.12.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8776 \
    CONTEST_STORAGE=mysql \
    CONTEST_MYSQL_HOST=127.0.0.1 \
    CONTEST_MYSQL_PORT=3306 \
    CONTEST_MYSQL_DATABASE=campus_final_scoring \
    CONTEST_MYSQL_USER=contest_scoring \
    CONTEST_MYSQL_TABLE_PREFIX=contest_final_

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/contest-server.mjs ./
COPY --from=build /app/src ./src
COPY --from=build /app/shared ./shared
COPY --from=build /app/domain ./domain
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist

EXPOSE 8776
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8776) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "contest-server.mjs"]
