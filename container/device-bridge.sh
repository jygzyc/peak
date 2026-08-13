#!/bin/bash
# device-bridge.sh — Host-side Android device bridge for Peak task containers.
#
# Peak containers reach the phone by REUSING the host adb server instead of USB
# passthrough: the host restarts adb in TCP mode (0.0.0.0:5037) and adb-forwards
# the frida-server port. Containers then connect through host.docker.internal.
# This avoids `--privileged` + `/dev/bus/usb`, which is unusable on Docker
# Desktop (Windows/macOS). Works on Linux/macOS/Windows(WSL2 backend) alike.
#
# Run this ON THE HOST (where the USB device is plugged in), not inside a task
# container. The container side is handled by /usr/local/bin/adb-setup.sh.
#
# Usage:
#   ./device-bridge.sh usb start       # USB mode (recommended)
#   ./device-bridge.sh wifi <IP> start # WiFi mode (socat forward, fallback)
#   ./device-bridge.sh usb status
#   ./device-bridge.sh usb stop
set -euo pipefail

MODE="${1:-usb}"
ACTION="${2:-start}"
PHONE_IP="${3:-}"

FRIDA_PORT="${FRIDA_SERVER_PORT:-14725}"
RUN_DIR="${PEAK_RUN_DIR:-${XDG_RUNTIME_DIR:-/tmp}}"
PIDFILE_ADB_SERVER="$RUN_DIR/peak-bridge-adb-server.pid"
PIDFILE_SOCAT_ADB="$RUN_DIR/peak-bridge-socat-adb.pid"
PIDFILE_SOCAT_FRIDA="$RUN_DIR/peak-bridge-socat-frida.pid"

check_socat() {
    command -v socat &>/dev/null || { echo "ERROR: socat not found. Install socat first." >&2; exit 1; }
}

# ============================================================
# USB mode
# Host adb server listens on TCP -> container connects via host.docker.internal
# Host adb-forwards frida port -> container connects via host.docker.internal
# No WiFi, no socat, just a USB cable.
# ============================================================
start_usb() {
    echo "=== Starting USB Device Bridge ==="
    echo "Mode: USB (host adb server reuse)"
    echo ""

    USB_DEVICES=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | grep -v "emulator" | head -5 || true)
    if [ -z "$USB_DEVICES" ]; then
        echo "ERROR: No USB device detected. Check:" >&2
        echo "  1. USB cable connected" >&2
        echo "  2. USB debugging enabled on the phone" >&2
        echo "  3. Authorized on the phone (RSA key dialog)" >&2
        echo "  Run 'adb devices' to verify" >&2
        exit 1
    fi
    echo "[+] USB device detected:"
    echo "$USB_DEVICES"
    echo ""

    # Kill the default adb server and restart it in TCP-listen mode.
    echo "[*] Restarting adb server in TCP mode (0.0.0.0:5037)..."
    adb kill-server 2>/dev/null || true
    sleep 1

    adb -a nodaemon server start &
    echo $! > "$PIDFILE_ADB_SERVER"
    sleep 2

    if ! kill -0 "$(cat "$PIDFILE_ADB_SERVER")" 2>/dev/null; then
        echo "[-] adb server failed to start" >&2
        exit 1
    fi
    echo "[+] adb server started (PID $(cat "$PIDFILE_ADB_SERVER"), 0.0.0.0:5037)"

    echo "[*] Setting up adb forward for frida-server (port $FRIDA_PORT)..."
    adb forward tcp:$FRIDA_PORT tcp:$FRIDA_PORT
    echo "[+] adb forward: localhost:$FRIDA_PORT -> device:$FRIDA_PORT"

    echo ""
    echo "=== USB Bridge Active ==="
    echo ""
    echo "From a Peak task container (adb-setup.sh / frida-auto.sh do this automatically):"
    echo "  export ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"
    echo "  adb devices"
    echo "  frida-auto.sh com.target crypto"
}

stop_usb() {
    echo "[*] Stopping USB bridge..."
    if [ -f "$PIDFILE_ADB_SERVER" ]; then
        PID=$(cat "$PIDFILE_ADB_SERVER")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null || true
            echo "[+] adb server stopped (PID $PID)"
        fi
        rm -f "$PIDFILE_ADB_SERVER"
    fi
    adb forward --remove tcp:$FRIDA_PORT 2>/dev/null || true
    adb start-server 2>/dev/null || true
    echo "[+] Default adb server restored; USB bridge stopped"
}

status_usb() {
    echo "=== USB Bridge Status ==="
    if [ -f "$PIDFILE_ADB_SERVER" ] && kill -0 "$(cat "$PIDFILE_ADB_SERVER")" 2>/dev/null; then
        echo "[+] adb server: RUNNING (PID $(cat "$PIDFILE_ADB_SERVER"), TCP 0.0.0.0:5037)"
    else
        echo "[-] adb server: NOT RUNNING"
        return
    fi
    USB_DEVICES=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | head -5 || true)
    if [ -n "$USB_DEVICES" ]; then
        echo "[+] USB device: CONNECTED"
        echo "$USB_DEVICES"
    else
        echo "[-] USB device: NOT CONNECTED"
    fi
    FORWARD_LIST=$(adb forward --list 2>/dev/null | grep "$FRIDA_PORT" || true)
    if [ -n "$FORWARD_LIST" ]; then
        echo "[+] Frida forward: ACTIVE"
        echo "    $FORWARD_LIST"
    else
        echo "[-] Frida forward: NOT SET"
    fi
}

# ============================================================
# WiFi mode (fallback): socat port-forward to a network adb device.
# ============================================================
start_wifi() {
    if [ -z "$PHONE_IP" ]; then
        echo "ERROR: WiFi mode requires the phone IP" >&2
        echo "Usage: $0 wifi <phone_ip> start" >&2
        exit 1
    fi
    check_socat
    echo "=== Starting WiFi Device Bridge ==="
    echo "Phone: $PHONE_IP"
    echo ""
    stop_wifi 2>/dev/null || true
    sleep 1

    echo "[*] Starting adb bridge (port 5555)..."
    socat TCP-LISTEN:5555,fork,reuseaddr,bind=0.0.0.0 TCP:${PHONE_IP}:5555 &
    echo $! > "$PIDFILE_SOCAT_ADB"

    echo "[*] Starting Frida bridge (port $FRIDA_PORT)..."
    socat TCP-LISTEN:${FRIDA_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:${PHONE_IP}:${FRIDA_PORT} &
    echo $! > "$PIDFILE_SOCAT_FRIDA"

    sleep 1
    echo "[+] Bridges up. From a container:"
    echo "    adb connect host.docker.internal:5555"
    echo "    frida -H host.docker.internal:$FRIDA_PORT -f com.target --no-pause"
}

stop_wifi() {
    for pidfile in "$PIDFILE_SOCAT_ADB" "$PIDFILE_SOCAT_FRIDA"; do
        if [ -f "$pidfile" ]; then
            kill "$(cat "$pidfile")" 2>/dev/null || true
            rm -f "$pidfile"
        fi
    done
    pkill -f "socat.*TCP-LISTEN:5555" 2>/dev/null || true
    pkill -f "socat.*TCP-LISTEN:${FRIDA_PORT}" 2>/dev/null || true
    echo "[+] WiFi bridge stopped"
}

case "$MODE" in
    usb)
        case "$ACTION" in
            start)   start_usb ;;
            stop)    stop_usb ;;
            status)  status_usb ;;
            restart) stop_usb; sleep 1; start_usb ;;
            *) echo "Usage: $0 usb [start|stop|status|restart]" >&2; exit 1 ;;
        esac
        ;;
    wifi)
        case "$ACTION" in
            start) start_wifi ;;
            stop)  stop_wifi ;;
            *) echo "Usage: $0 wifi <phone_ip> [start|stop]" >&2; exit 1 ;;
        esac
        ;;
    *)
        echo "Usage:"
        echo "  $0 usb [start|stop|status]         # USB mode (recommended)"
        echo "  $0 wifi <phone_ip> [start|stop]    # WiFi mode (fallback)"
        ;;
esac
