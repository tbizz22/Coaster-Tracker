# Scraper service only (server.js) — the SPA deploys separately as a static
# build (see README "Deployment"). Uses Playwright's own image so the headless-
# Chromium system deps (used by scrape-heights.js) are already present.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js scrape-heights.js ./

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
