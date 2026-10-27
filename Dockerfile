# repo-radar Web Analyzer (Experimental Preview). No secrets are baked in: pass GITHUB_TOKEN at run time.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY standards ./standards
COPY profiles ./profiles
COPY schemas ./schemas
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/web/server.js"]
