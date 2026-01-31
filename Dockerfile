FROM node:20

RUN apt update && apt install -y ffmpeg curl

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY . .
RUN npm install

EXPOSE 5000
CMD ["node", "server.js"]
