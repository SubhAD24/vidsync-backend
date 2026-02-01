FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm install

EXPOSE 8080
CMD ["npm", "start"]
