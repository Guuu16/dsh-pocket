#!/bin/sh
# Start the dsh-pocket gateway.
#
#   ./start.sh              run in the foreground (Ctrl-C stops it)
#   ./start.sh --daemon     run in the background, logging to ~/.dsh-pocket/pocket.log
#   ./start.sh --stop       stop a background instance
#   ./start.sh --status     report whether it is running and print the paired URLs
#
# Extra arguments are passed through to the gateway, e.g. `./start.sh --port 9000`.

set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=${DSH_POCKET_HOME:-$HOME/.dsh-pocket}
LOG="$HOME_DIR/pocket.log"
PIDFILE="$HOME_DIR/pocket.pid"
NODE=${NODE:-node}
MATCH="bin/dsh-pocket.mjs"

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  --daemon)
    shift
    if running; then
      echo "dsh-pocket already running (pid $(cat "$PIDFILE"))"
    else
      mkdir -p "$HOME_DIR"
      cd "$DIR"
      # shellcheck disable=SC2086 # extra flags are passed through deliberately
      nohup "$NODE" bin/dsh-pocket.mjs "$@" > "$LOG" 2>&1 &
      echo $! > "$PIDFILE"
      sleep 3
      echo "dsh-pocket started (pid $(cat "$PIDFILE")), log: $LOG"
    fi
    sed -n '1,20p' "$LOG"
    ;;
  --stop)
    if running; then
      kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE"
      echo "dsh-pocket stopped"
    else
      pkill -f "$MATCH" 2>/dev/null && echo "dsh-pocket stopped" || echo "dsh-pocket not running"
      rm -f "$PIDFILE"
    fi
    ;;
  --status)
    if running || pgrep -f "$MATCH" >/dev/null 2>&1; then
      echo "dsh-pocket is running"
      "$NODE" "$DIR/bin/dsh-pocket.mjs" --print-access-url
    else
      echo "dsh-pocket is not running"
      exit 1
    fi
    ;;
  *)
    cd "$DIR"
    exec "$NODE" bin/dsh-pocket.mjs "$@"
    ;;
esac
