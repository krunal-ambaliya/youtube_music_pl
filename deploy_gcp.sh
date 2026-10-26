#!/usr/bin/env bash
# ==============================================================================
# TuneVault PRO - Automated Installation & Start Script for Google Cloud (GCP)
# Supports: Ubuntu, Debian, Rocky/CentOS, and GCP Compute Engine VMs
# ==============================================================================

set -euo pipefail

# ANSI color codes for stylish terminal logs
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8000}"
SERVICE_NAME="tunevault"

echo -e "\n${CYAN}${BOLD}======================================================${NC}"
echo -e "${CYAN}${BOLD}       TuneVault PRO - GCP Auto Installer & Launcher   ${NC}"
echo -e "${CYAN}${BOLD}======================================================${NC}\n"

# Helper for elevated commands
SUDO=""
if [ "$EUID" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        echo -e "${RED}[ERROR] This script requires root privileges or sudo to install system packages.${NC}"
        exit 1
    fi
fi

# 1. Detect Package Manager & Install System Packages
echo -e "${YELLOW}==> [1/6] Installing system dependencies (FFmpeg, Python, Deno, Curl)...${NC}"
if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ffmpeg \
        curl \
        git \
        unzip \
        ca-certificates
elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf update -y
    $SUDO dnf install -y epel-release || true
    $SUDO dnf install -y python3 python3-pip python3-devel ffmpeg curl git unzip ca-certificates
elif command -v yum >/dev/null 2>&1; then
    $SUDO yum update -y
    $SUDO yum install -y epel-release || true
    $SUDO yum install -y python3 python3-pip ffmpeg curl git unzip ca-certificates
else
    echo -e "${YELLOW}[WARNING] Unknown package manager. Please ensure python3, ffmpeg, and curl are installed.${NC}"
fi

# 2. Check / Install Deno (JavaScript Runtime for yt-dlp challenges)
echo -e "\n${YELLOW}==> [2/6] Verifying Deno installation (for YouTube JS challenge solving)...${NC}"
if ! command -v deno >/dev/null 2>&1 && [ ! -f "$HOME/.deno/bin/deno" ] && [ ! -f "/usr/local/bin/deno" ]; then
    echo -e "${CYAN}Installing Deno to /usr/local/bin...${NC}"
    export DENO_INSTALL=/usr/local
    curl -fsSL https://deno.land/install.sh | $SUDO sh
else
    echo -e "${GREEN}Deno is already installed: $(command -v deno || echo "$HOME/.deno/bin/deno")${NC}"
fi

# Ensure Deno is accessible in PATH
if [ -d "$HOME/.deno/bin" ]; then
    export PATH="$HOME/.deno/bin:$PATH"
fi

# 3. Create & Activate Python Virtual Environment
echo -e "\n${YELLOW}==> [3/6] Setting up Python virtual environment...${NC}"
cd "$APP_DIR"
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate

# 4. Install & Upgrade Python Dependencies
echo -e "\n${YELLOW}==> [4/6] Installing Python dependencies from requirements.txt...${NC}"
pip install --upgrade pip setuptools wheel --quiet
pip install -r requirements.txt --quiet

# Ensure downloads directory exists
mkdir -p "$APP_DIR/downloads"

# 5. Get VM Public / Private IPs
echo -e "\n${YELLOW}==> [5/6] Resolving server network addresses...${NC}"
INTERNAL_IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "127.0.0.1")
EXTERNAL_IP=$(curl -s -m 3 https://checkip.amazonaws.com || curl -s -m 3 https://ifconfig.me || echo "EXTERNAL_IP")

# 6. Ask or Configure systemd Service vs Foreground Run
echo -e "\n${YELLOW}==> [6/6] Launch configuration...${NC}"

# Check if user wants systemd service or interactive foreground
CREATE_SERVICE="${1:-ask}"

if [ "$CREATE_SERVICE" != "foreground" ] && [ "$CREATE_SERVICE" != "run" ]; then
    read -p "Would you like to install TuneVault as a persistent systemd background service? (y/N): " -r RESPONSE || RESPONSE="n"
else
    RESPONSE="n"
fi

if [[ "$RESPONSE" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    CURRENT_USER=$(whoami)
    
    echo -e "${CYAN}Creating systemd service at ${SERVICE_FILE}...${NC}"
    $SUDO bash -c "cat <<EOF > ${SERVICE_FILE}
[Unit]
Description=TuneVault PRO Music Playlist Downloader
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${APP_DIR}
Environment=\"PATH=${APP_DIR}/venv/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.deno/bin\"
Environment=\"PORT=${PORT}\"
Environment=\"HOST=0.0.0.0\"
ExecStart=${APP_DIR}/venv/bin/uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF"

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable ${SERVICE_NAME}
    $SUDO systemctl restart ${SERVICE_NAME}

    echo -e "\n${GREEN}${BOLD}✓ TuneVault service installed and started successfully!${NC}"
    echo -e "${CYAN}Status:  ${NC} sudo systemctl status ${SERVICE_NAME}"
    echo -e "${CYAN}Restart: ${NC} sudo systemctl restart ${SERVICE_NAME}"
    echo -e "${CYAN}Logs:    ${NC} journalctl -u ${SERVICE_NAME} -f"
else
    echo -e "\n${GREEN}${BOLD}======================================================${NC}"
    echo -e "${GREEN}${BOLD} ✓ Installation Complete! Starting TuneVault PRO...  ${NC}"
    echo -e "${GREEN}${BOLD}======================================================${NC}"
    echo -e "${CYAN}Local Address:   ${NC} http://localhost:${PORT}"
    echo -e "${CYAN}Internal Network:${NC} http://${INTERNAL_IP}:${PORT}"
    echo -e "${CYAN}Public Web URL:  ${NC} http://${EXTERNAL_IP}:${PORT}"
    echo -e "\n${YELLOW}GCP Firewall Note:${NC} If http://${EXTERNAL_IP}:${PORT} is unreachable, run this in Google Cloud Shell:"
    echo -e "  ${BOLD}gcloud compute firewall-rules create allow-tunevault --allow tcp:${PORT} --target-tags=tunevault-server${NC}\n"

    exec uvicorn app:app --host 0.0.0.0 --port "${PORT}" --workers 2
fi

echo -e "\n${GREEN}${BOLD}Access TuneVault at:${NC} http://${EXTERNAL_IP}:${PORT}\n"
