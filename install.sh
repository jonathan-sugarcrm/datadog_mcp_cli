#!/bin/bash
# install.sh - Installs the latest stable release of datadog_mcp_cli

set -e # Exit immediately if a command exits with a non-zero status.

# --- Configuration ---
INSTALL_DIR="${HOME}/.local/bin"
CMD_NAME="datadog_mcp_cli" # The command name after installation
PROJECT_NAME="datadog_mcp_cli" # Binary name
BASE_DOWNLOAD_URL="https://coterm.datadoghq.com/mcp-cli" # Base URL for downloads

# --- Helper Functions ---
err() {
  echo "[ERROR] $*" >&2
  exit 1
}

ensure_command() {
  command -v "$1" >/dev/null 2>&1 || err "Command not found: '$1'. Please install it."
}

# --- Ensure required tools are installed ---
ensure_command curl

# --- Detect OS and Architecture ---
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    PLATFORM="linux"
    ;;
  Darwin)
    PLATFORM="macos"
    ;;
  *)
    err "Unsupported operating system: $OS"
    ;;
esac

case "$ARCH" in
  x86_64 | amd64)
    CPU_ARCH="amd64"
    ;;
  aarch64 | arm64)
    CPU_ARCH="arm64"
    ;;
  *)
    err "Unsupported architecture: $ARCH"
    ;;
esac

# --- Determine Asset Suffix based on OS ---
ASSET_SUFFIX=""
if [ "$PLATFORM" = "linux" ]; then
    # Support both amd64 and arm64 for Linux
    if [ "$CPU_ARCH" != "amd64" ] && [ "$CPU_ARCH" != "arm64" ]; then
        err "Unsupported Linux architecture: $CPU_ARCH. Only amd64 and arm64 are supported."
    fi
    ASSET_SUFFIX="linux-${CPU_ARCH}"
elif [ "$PLATFORM" = "macos" ]; then
    # Use the CPU_ARCH detected earlier for macOS
    if [ "$CPU_ARCH" != "amd64" ] && [ "$CPU_ARCH" != "arm64" ]; then
         err "Unsupported macOS architecture: $CPU_ARCH. Only amd64 and arm64 are supported."
    fi
    ASSET_SUFFIX="macos-${CPU_ARCH}"
else
    err "Logic error: Should not reach here." # Should have exited earlier
fi


echo "Detected Platform: $PLATFORM ($CPU_ARCH)"
echo "Expected Asset Suffix: $ASSET_SUFFIX"

# --- Determine Download URL ---
# Construct the asset filename and download URL directly from S3 path
ASSET_FILENAME="${PROJECT_NAME}-${ASSET_SUFFIX}"
DOWNLOAD_URL="${BASE_DOWNLOAD_URL}/${ASSET_FILENAME}"

echo "Constructed download URL: $DOWNLOAD_URL"

# --- Ensure Install Directory Exists ---
echo "Ensuring installation directory exists: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" # Ensure the installation directory exists

# --- Download Binary ---
INSTALL_PATH="$INSTALL_DIR/$CMD_NAME"
TEMP_DOWNLOAD_PATH="${INSTALL_PATH}.tmp" # Temporary download location

echo "Downloading $PROJECT_NAME to $TEMP_DOWNLOAD_PATH..."
HTTP_CODE=$(curl -sSL -w "%{http_code}" -o "$TEMP_DOWNLOAD_PATH" "$DOWNLOAD_URL")
if [ "$HTTP_CODE" -eq 200 ]; then
    echo "Download complete."
    # Verify the downloaded file is not empty
    if [ ! -s "$TEMP_DOWNLOAD_PATH" ]; then
        rm -f "$TEMP_DOWNLOAD_PATH"
        err "Downloaded file is empty. The binary may not be available for your platform."
    fi
    # Check if the binary already exists and remove it
    if [ -f "$INSTALL_PATH" ]; then
        echo "Removing existing binary at $INSTALL_PATH..."
        rm -f "$INSTALL_PATH" || err "Failed to remove existing binary."
    fi
    # Move the new binary to the final location
    mv "$TEMP_DOWNLOAD_PATH" "$INSTALL_PATH" || err "Failed to move downloaded binary to $INSTALL_PATH."
else
    # Clean up temporary file if download failed
    if [ -f "$TEMP_DOWNLOAD_PATH" ]; then
        rm -f "$TEMP_DOWNLOAD_PATH"
    fi
    case "$HTTP_CODE" in
        404)
            err "Binary not found (HTTP 404). The binary may not be available for your platform ($PLATFORM-$CPU_ARCH)."
            ;;
        403)
            err "Access denied (HTTP 403). Check if the download URL is correct."
            ;;
        *)
            err "Download failed with HTTP code $HTTP_CODE. Check URL or network connection."
            ;;
    esac
fi

# --- Set Permissions ---
echo "Setting execute permissions on $INSTALL_PATH..."
chmod 755 "$INSTALL_PATH"

# --- Post-installation Message ---
echo ""
echo "'$CMD_NAME' installed successfully to $INSTALL_DIR/$CMD_NAME"
echo ""
# Check if INSTALL_DIR is in PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo "WARNING: '$INSTALL_DIR' is not found in your PATH environment variable."
  echo "You may need to add it to your shell configuration file (e.g., ~/.bashrc, ~/.zshrc):"
  echo ""
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
  echo "Then, restart your shell or run 'source ~/.your_shell_rc_file'."
else
  echo "Run '$CMD_NAME --version' to check the installation."
fi

echo ""
echo "IMPORTANT: Before using the MCP proxy with MCP clients, please run:"
echo "  $CMD_NAME login"
echo ""
echo "This will authenticate you with Datadog via OAuth. The login process"
echo "will open your browser and guide you through region selection."

exit 0
