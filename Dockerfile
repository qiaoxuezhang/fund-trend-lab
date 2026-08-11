FROM node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY src ./src

RUN mkdir -p /app/.cache && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173
CMD ["node", "server.mjs"]
