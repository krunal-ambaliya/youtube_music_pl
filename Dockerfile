FROM python:3.12-slim

# Avoid interactive prompts during apt installations
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    HOST=0.0.0.0

# Install system prerequisites: ffmpeg (audio/video processing), curl, unzip, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Deno for yt-dlp JavaScript challenge solver
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools wheel && \
    pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Ensure downloads directory exists with write permissions
RUN mkdir -p downloads && chmod 777 downloads

EXPOSE 8080

# Run uvicorn on container port
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 2"]
