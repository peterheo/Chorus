# Chorus live runner. State and the receipt key live in /data (mount a volume).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
ENV CHORUS_DB=/data/chorus.db
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/cli/live.ts"]
