#!/bin/bash
# frida-auto.sh — Pick a frida hook bundle by analysis scenario.
# Usage: frida-auto.sh <package> [mode] [-H host:port | -U]
#   mode: crypto | ssl | root | custom:<script.js> | all
#
# Connection (in a Peak container the host frida-server is reached via the
# host-gateway; the host's `peak device-bridge usb start` adb-forwards 14725):
#   (default in container)  -H host.docker.internal:14725
#   -H <host:port>          explicit remote frida-server
#   -U                      local USB device (outside a container)
#   FRIDA_HOST=host:port    environment variable
set -euo pipefail

PKG=""
MODE="crypto"
FRIDA_CONN=""

while [ $# -gt 0 ]; do
    case "$1" in
        -H|--remote) FRIDA_CONN="$2"; shift 2 ;;
        -U|--usb)    FRIDA_CONN=""; shift ;;
        -*)          echo "Unknown option: $1" >&2; exit 1 ;;
        *)
            if [ -z "$PKG" ]; then PKG="$1"; else MODE="$1"; fi
            shift
            ;;
    esac
done

FRIDA_SERVER_PORT="${FRIDA_SERVER_PORT:-14725}"
HOST_GATEWAY="${HOST_GATEWAY:-host.docker.internal}"

if [ -n "${FRIDA_HOST:-}" ] && [ -z "$FRIDA_CONN" ]; then
    FRIDA_CONN="$FRIDA_HOST"
fi

# In a container default to the host frida-server reached through the gateway.
if [ -z "$FRIDA_CONN" ] && [ -f /.dockerenv ]; then
    FRIDA_CONN="${HOST_GATEWAY}:${FRIDA_SERVER_PORT}"
fi

if [ -z "$PKG" ]; then
    echo "Usage: frida-auto.sh <package> [mode] [-H host:port | -U]" >&2
    echo "Modes: crypto, ssl, root, custom:<script.js>, all" >&2
    exit 1
fi

HOOK_DIR="${PEAK_FRIDA_HOOKS:-/opt/peak/frida-hooks}"

if [ -n "$FRIDA_CONN" ]; then
    FRIDA_ARGS="-H $FRIDA_CONN"
    echo "[*] Remote mode: connecting to frida-server at $FRIDA_CONN"
else
    FRIDA_ARGS="-U"
    echo "[*] USB mode: connecting to local USB device"
fi

COMBINED=""
CLEANUP=false

case "$MODE" in
    crypto)        HOOK_FILES=("$HOOK_DIR/crypto-hook.js") ;;
    ssl)           HOOK_FILES=("$HOOK_DIR/ssl-pinning-bypass.js") ;;
    root)          HOOK_FILES=("$HOOK_DIR/root-bypass.js") ;;
    custom:*)
        CUSTOM_SCRIPT="${MODE#custom:}"
        [ ! -f "$CUSTOM_SCRIPT" ] && { echo "ERROR: Custom script not found: $CUSTOM_SCRIPT" >&2; exit 1; }
        HOOK_FILES=("$CUSTOM_SCRIPT")
        ;;
    all)           HOOK_FILES=("$HOOK_DIR/crypto-hook.js" "$HOOK_DIR/ssl-pinning-bypass.js" "$HOOK_DIR/root-bypass.js") ;;
    *)
        echo "Unknown mode: $MODE" >&2
        echo "Available: crypto, ssl, root, custom:<script>, all" >&2
        exit 1
        ;;
esac

if [ ${#HOOK_FILES[@]} -eq 1 ]; then
    COMBINED="${HOOK_FILES[0]}"
else
    COMBINED=$(mktemp /tmp/frida-combined-XXXXXX.js)
    CLEANUP=true
    for f in "${HOOK_FILES[@]}"; do cat "$f" >> "$COMBINED"; echo -e "\n" >> "$COMBINED"; done
fi

echo "[*] Starting frida..."
echo "[*]   Package: $PKG"
echo "[*]   Hooks:   $(basename "$COMBINED")"
echo "[*]   Args:    $FRIDA_ARGS"
echo ""

cleanup() { $CLEANUP && [ -f "$COMBINED" ] && rm -f "$COMBINED"; }
trap cleanup EXIT

frida $FRIDA_ARGS -f "$PKG" -l "$COMBINED" --no-pause
