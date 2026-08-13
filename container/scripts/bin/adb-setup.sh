#!/bin/bash
# adb-setup.sh — adb connection management + app info, Peak-style.
#
# In a Peak task container the device is reached through the HOST adb server:
# the host runs `peak device-bridge usb start`, which restarts adb in TCP mode
# (0.0.0.0:5037) and forwards the frida-server port. The container reuses that
# server via ADB_SERVER_SOCKET=tcp:host.docker.internal:5037 — no USB passthrough,
# no privileged mode, works on Linux/macOS/Windows(Docker Desktop) alike.
#
# Usage:
#   adb-setup.sh                       # check connection status (auto-connect in container)
#   adb-setup.sh devices               # list connected devices
#   adb-setup.sh connect <ip[:port]>   # WiFi ADB connect (default port 5555)
#   adb-setup.sh connect-usb           # connect through the host adb server (container default)
#   adb-setup.sh shell                 # device shell
#   adb-setup.sh pull <pkg>            # pull APK into $ANALYSIS_DIR
#   adb-setup.sh dump <pkg>            # dump APK + app data
#   adb-setup.sh frida                 # check frida-server status on device
#   adb-setup.sh frida-push            # download + push frida-server to device (needs root)
#   adb-setup.sh frida-start           # start frida-server on device
#
# Environment:
#   ADB_SERVER_SOCKET   — adb server endpoint (default tcp:host.docker.internal:5037)
#   ADB_TARGET          — explicit connect target IP:PORT
#   FRIDA_SERVER_PORT   — frida-server port (default 14725)
set -euo pipefail

CMD="${1:-status}"
PKG="${2:-}"
ANALYSIS_DIR="${ANALYSIS_DIR:-$PWD/analysis}"
ADB_TARGET="${ADB_TARGET:-}"
FRIDA_SERVER_PORT="${FRIDA_SERVER_PORT:-14725}"
HOST_GATEWAY="${HOST_GATEWAY:-host.docker.internal}"

IN_CONTAINER=false
if [ -f /.dockerenv ] || grep -q docker /proc/1/cgroup 2>/dev/null; then
    IN_CONTAINER=true
fi

check_adb() {
    if ! command -v adb &>/dev/null; then
        echo "ERROR: adb not found. Is Android platform-tools in PATH?" >&2
        exit 1
    fi
}

# Point the container's adb at the host adb server so it reuses the host's USB
# device list. On the host itself this is a harmless default that is overridden.
ensure_host_socket() {
    if $IN_CONTAINER && [ -z "${ADB_SERVER_SOCKET:-}" ]; then
        export ADB_SERVER_SOCKET="tcp:${HOST_GATEWAY}:5037"
    fi
}

auto_connect() {
    check_adb
    ensure_host_socket
    echo "=== Auto-connecting ADB (ADB_SERVER_SOCKET=${ADB_SERVER_SOCKET:-unset}) ==="

    if [ -n "$ADB_TARGET" ]; then
        echo "[*] Using ADB_TARGET=$ADB_TARGET"
        adb connect "$ADB_TARGET"
        return $?
    fi

    if $IN_CONTAINER; then
        if timeout 3 bash -c "echo >/dev/tcp/${HOST_GATEWAY}/5037" 2>/dev/null; then
            echo "[+] Host adb server reachable on ${HOST_GATEWAY}:5037"
            DEVICES=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | head -5 || true)
            if [ -n "$DEVICES" ]; then
                echo "[+] USB device visible through host adb server"
            else
                echo "[-] Host adb server reachable, but no authorized USB device is visible"
                echo "    Make sure the host ran: peak device-bridge usb start"
                echo "    Then confirm the phone USB debugging authorization dialog"
            fi
        else
            echo "[-] Host adb server not reachable on ${HOST_GATEWAY}:5037"
            echo "    Start the host-side USB bridge first: peak device-bridge usb start"
        fi

        if timeout 3 bash -c "echo >/dev/tcp/${HOST_GATEWAY}/${FRIDA_SERVER_PORT}" 2>/dev/null; then
            echo "[+] Port ${FRIDA_SERVER_PORT} (frida-server) reachable on ${HOST_GATEWAY}"
        else
            echo "[-] Port ${FRIDA_SERVER_PORT} (frida-server) not reachable on ${HOST_GATEWAY}"
            echo "    Make sure frida-server runs on the phone and adb forward is active"
        fi
        return 0
    fi

    echo "[*] Not in a container, checking direct USB/TCP connections..."
    DEVICES=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | head -5)
    if [ -z "$DEVICES" ]; then
        echo "No devices connected."
        echo "Connection methods:"
        echo "  adb connect <phone_ip>:5555           # WiFi ADB"
        echo "  adb connect localhost:5555             # Emulator"
        echo "  adb connect 127.0.0.1:7555            # MuMu"
        echo "  adb connect 127.0.0.1:62001           # LDPlayer"
    else
        echo "Already connected:"
        echo "$DEVICES"
    fi
}

case "$CMD" in
    status)
        auto_connect
        echo ""
        echo "=== ADB Status ==="
        ensure_host_socket
        DEVICES=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | head -5)
        if [ -z "$DEVICES" ]; then
            echo "No devices connected."
            $IN_CONTAINER && echo "" && echo "Container detected. Run: adb-setup.sh connect-usb"
        else
            echo "$DEVICES"
            echo ""
            adb shell getprop ro.build.version.release 2>/dev/null | xargs -I{} echo "Android version: {}" || true
            adb shell getprop ro.product.model 2>/dev/null | xargs -I{} echo "Device: {}" || true
            adb shell getprop ro.build.type 2>/dev/null | xargs -I{} echo "Build type: {}" || true
            ROOT_STATUS=$(adb shell "su -c 'id'" 2>/dev/null || echo "not available")
            echo "Root: $ROOT_STATUS"
            FRIDA_STATUS=$(adb shell "su -c 'ps -A | grep frida-server'" 2>/dev/null || echo "not running")
            echo "Frida server: $FRIDA_STATUS"
        fi
        ;;
    devices)
        check_adb; ensure_host_socket
        adb devices -l
        ;;
    connect)
        check_adb; ensure_host_socket
        TARGET="${2:-}"
        if [ -z "$TARGET" ]; then
            echo "Usage: adb-setup.sh connect <ip[:port]>" >&2
            exit 1
        fi
        [[ ! "$TARGET" =~ :[0-9]+$ ]] && TARGET="$TARGET:5555"
        echo "[*] Connecting to $TARGET ..."
        adb connect "$TARGET"
        ;;
    connect-usb)
        echo "=== USB Mode (via host adb server) ==="
        export ADB_SERVER_SOCKET="tcp:${HOST_GATEWAY}:5037"
        echo "ADB_SERVER_SOCKET=$ADB_SERVER_SOCKET"
        echo ""
        DEVICES=$(adb devices 2>/dev/null | grep -v "List" | grep -v "^$" | head -5)
        if [ -z "$DEVICES" ]; then
            echo "[-] No devices found via host adb server"
            echo "    Make sure the host runs: peak device-bridge usb start"
        else
            echo "[+] Connected to host adb server:"
            echo "$DEVICES"
        fi
        ;;
    shell)
        check_adb; ensure_host_socket
        adb shell
        ;;
    pull)
        check_adb; ensure_host_socket
        if [ -z "$PKG" ]; then echo "Usage: adb-setup.sh pull <package>" >&2; exit 1; fi
        echo "[*] Finding APK path for $PKG..."
        APKPATH=$(adb shell pm path "$PKG" 2>/dev/null | head -1 | sed 's/package://')
        if [ -z "$APKPATH" ]; then
            echo "ERROR: Package not found: $PKG" >&2
            exit 1
        fi
        mkdir -p "$ANALYSIS_DIR"
        echo "[*] Pulling $APKPATH ..."
        adb pull "$APKPATH" "$ANALYSIS_DIR/${PKG}.apk"
        echo "[+] Saved to $ANALYSIS_DIR/${PKG}.apk"
        ;;
    dump)
        check_adb; ensure_host_socket
        if [ -z "$PKG" ]; then echo "Usage: adb-setup.sh dump <package>" >&2; exit 1; fi
        mkdir -p "$ANALYSIS_DIR/$PKG"
        echo "[*] Dumping info for $PKG..."
        adb shell dumpsys package "$PKG" > "$ANALYSIS_DIR/$PKG/package_info.txt" 2>/dev/null || true
        adb shell "su -c 'ls /data/data/$PKG/shared_prefs/'" 2>/dev/null > "$ANALYSIS_DIR/$PKG/shared_prefs_list.txt" || true
        adb shell "su -c 'ls /data/data/$PKG/databases/'" 2>/dev/null > "$ANALYSIS_DIR/$PKG/databases_list.txt" || true
        APKPATH=$(adb shell pm path "$PKG" 2>/dev/null | head -1 | sed 's/package://')
        [ -n "$APKPATH" ] && adb pull "$APKPATH" "$ANALYSIS_DIR/$PKG/base.apk" 2>/dev/null || true
        echo "[+] Dump saved to $ANALYSIS_DIR/$PKG/"
        ;;
    frida)
        check_adb; ensure_host_socket
        echo "[*] Checking frida-server..."
        FRIDA_RUNNING=$(adb shell "su -c 'ps -A | grep frida-server'" 2>/dev/null || true)
        if [ -n "$FRIDA_RUNNING" ]; then
            echo "[+] Frida server is running:"
            echo "$FRIDA_RUNNING"
        else
            echo "[-] Frida server NOT running."
            echo "Start with: adb-setup.sh frida-start"
            echo "Manual: adb shell 'su -c /data/local/tmp/frida-server -D -l 0.0.0.0:$FRIDA_SERVER_PORT &'"
        fi
        ;;
    frida-push)
        check_adb; ensure_host_socket
        echo "[*] Looking for a matching frida-server binary..."
        FRIDA_VER=$(python3 -c "import frida; print(frida.__version__)" 2>/dev/null || echo "")
        if [ -z "$FRIDA_VER" ]; then
            echo "ERROR: Cannot detect frida version" >&2
            exit 1
        fi
        echo "[*] Frida client version: $FRIDA_VER"
        ARCH=$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')
        echo "[*] Device architecture: $ARCH"
        case "$ARCH" in
            arm64-v8a)   FRIDA_ARCH="arm64" ;;
            armeabi-v7a) FRIDA_ARCH="arm" ;;
            x86_64)      FRIDA_ARCH="x86_64" ;;
            x86)         FRIDA_ARCH="x86" ;;
            *)           echo "ERROR: Unknown architecture: $ARCH" >&2; exit 1 ;;
        esac
        SERVER_NAME="frida-server-${FRIDA_VER}-android-${FRIDA_ARCH}"
        URL="https://github.com/frida/frida/releases/download/${FRIDA_VER}/${SERVER_NAME}.xz"
        echo "[*] Downloading $SERVER_NAME.xz ..."
        TMPDIR=$(mktemp -d)
        curl -fSL -o "$TMPDIR/frida-server.xz" "$URL"
        xz -d "$TMPDIR/frida-server.xz"
        echo "[*] Pushing to device..."
        adb push "$TMPDIR/frida-server" /data/local/tmp/frida-server
        adb shell "su -c 'chmod 755 /data/local/tmp/frida-server'"
        rm -rf "$TMPDIR"
        echo "[+] frida-server pushed. Start with: adb-setup.sh frida-start"
        ;;
    frida-start)
        check_adb; ensure_host_socket
        echo "[*] Starting frida-server on device (port $FRIDA_SERVER_PORT)..."
        adb shell "su -c 'killall frida-server 2>/dev/null; /data/local/tmp/frida-server -D -l 0.0.0.0:$FRIDA_SERVER_PORT &'" 2>/dev/null || true
        sleep 2
        FRIDA_RUNNING=$(adb shell "su -c 'ps -A | grep frida-server'" 2>/dev/null || true)
        if [ -n "$FRIDA_RUNNING" ]; then
            echo "[+] Frida server started on port $FRIDA_SERVER_PORT"
            $IN_CONTAINER && echo "    Connect with: frida-auto.sh <pkg> <mode> -H ${HOST_GATEWAY}:$FRIDA_SERVER_PORT"
        else
            echo "[-] Failed to start frida-server" >&2
        fi
        ;;
    *)
        echo "Usage: adb-setup.sh [command] [args]" >&2
        echo "Commands: status, devices, connect <ip:port>, connect-usb, shell," >&2
        echo "          pull <pkg>, dump <pkg>, frida, frida-push, frida-start" >&2
        exit 1
        ;;
esac
