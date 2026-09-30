FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
