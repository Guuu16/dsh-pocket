#!/bin/sh
# Start the dsh-remote gateway.
#
#   ./start.sh              run in the foreground (Ctrl-C stops it)
#   ./start.sh --daemon     run in the background, logging to ~/.dsh-remote/remote.log
#   ./start.sh --stop       stop a background instance
#   ./start.sh --status     report whether it is running and print the paired URLs
#
# Extra arguments are passed through to the gateway, e.g. `./start.sh --port 9000`.

set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${DSH_REMOTE_HOME:-$HOME/.dsh-remote}
LOG="$HOME_DIR/remote.log"
PIDFILE="$HOME_DIR/remote.pid"
NODE=${NODE:-node}
MATCH="bin/dsh-remote.mjs"

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  --daemon)
    shift
    if running; then
      echo "dsh-remote already running (pid $(cat "$PIDFILE"))"
    else
      mkdir -p "$HOME_DIR"
      cd "$DIR"
      # shellcheck disable=SC2086 # extra flags are passed through deliberately
      nohup "$NODE" bin/dsh-remote.mjs "$@" > "$LOG" 2>&1 &
      echo $! > "$PIDFILE"
      sleep 3
      echo "dsh-remote started (pid $(cat "$PIDFILE")), log: $LOG"
    fi
    sed -n '1,20p' "$LOG"
    ;;
  --stop)
    if running; then
      kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE"
      echo "dsh-remote stopped"
    else
      pkill -f "$MATCH" 2>/dev/null && echo "dsh-remote stopped" || echo "dsh-remote not running"
      rm -f "$PIDFILE"
    fi
    ;;
  --status)
    if running || pgrep -f "$MATCH" >/dev/null 2>&1; then
      echo "dsh-remote is running"
      "$NODE" "$DIR/bin/dsh-remote.mjs" --print-access-url
    else
      echo "dsh-remote is not running"
      exit 1
    fi
    ;;
  *)
    cd "$DIR"
    exec "$NODE" bin/dsh-remote.mjs "$@"
    ;;
esac
