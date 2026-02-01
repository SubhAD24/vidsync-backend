FROM node:20-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    pipx \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Make pipx available
ENV PATH=/root/.local/bin:$PATH

# Install yt-dlp safely (PEP 668 compliant)
RUN pipx install yt-dlp

# Set work directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install node dependencies
RUN npm install --production

# Copy rest of app
COPY . .

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "server.js"]
