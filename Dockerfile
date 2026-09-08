FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY app.js index.html style.css server.js ./

ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
