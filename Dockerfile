FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache ca-certificates curl openssl

COPY scripts/install-mincifry-ca.sh /usr/local/bin/install-mincifry-ca
RUN chmod +x /usr/local/bin/install-mincifry-ca && /usr/local/bin/install-mincifry-ca

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

USER node

CMD ["node", "src/index.js"]
