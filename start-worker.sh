#!/bin/bash
#
# Ephemeral worker entrypoint — records ONE meeting, then the container exits
# (backend runs it with `--rm`). Concurrency across meetings is achieved by
# running one of these containers per meeting; each is fully isolated, so
# concurrent Microsoft Teams recordings work "for free" (own screen + own sink).
#
# Display / audio layout (a single container only ever runs ONE provider, so the
# two display subsystems never clash — the unused one just sits idle):
#   :98  → real Google Chrome + CDP proxy on :9223   → Google/Zoom (tab capture)
#   :99  → in-container Playwright browser + ffmpeg x11grab → Microsoft Teams
#   PulseAudio null sink `virtual_output` → Teams audio (harmless for the others)
#
# Env (set by the backend Docker orchestrator per meeting): MEETING_ID,
# MEETING_URL, MEETING_PROVIDER, BOT_NAME + MinIO/Redis delivery vars. Bot-internal
# defaults (AUDIO_ONLY, GOOGLE_CHROME_CDP_URL=http://localhost:9223, ...) are baked
# into the image (Dockerfile.worker).

set -uo pipefail

export DISPLAY=:99
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# Clear any stale pulse pid/socket from an unclean prior run (see start.sh note).
rm -rf "$XDG_RUNTIME_DIR/pulse"

wait_for_pulseaudio() {
  for _ in {1..25}; do
    pactl info >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# ── PulseAudio: single daemon + null sink (Teams needs it; others ignore it) ──
pulseaudio --kill 2>/dev/null || true
for _ in {1..10}; do pgrep -x pulseaudio >/dev/null || break; sleep 0.1; done
pulseaudio -D --exit-idle-time=-1 --log-level=info 2>&1 || true
if wait_for_pulseaudio; then
  echo "✓ PulseAudio is running (PID: $(pgrep -x pulseaudio))"
  pactl load-module module-null-sink sink_name=virtual_output sink_properties=device.description="Virtual_Output" 2>&1 || true
  pactl set-default-sink virtual_output 2>&1 || true
  if pactl list sources short | grep -q "virtual_output.monitor"; then
    echo "✓ virtual_output.monitor ready for ffmpeg (Teams)"
  else
    echo "✗ WARNING: virtual_output.monitor not found"
  fi
else
  echo "✗ WARNING: PulseAudio failed to start (Teams recording may fail; Google/Zoom unaffected)"
fi

# ── chrome-cdp sidecar on its own display :98 (real Chrome for Google/Zoom) ──
# Teams ignores this and uses the in-container Playwright browser on :99.
DISPLAY=:98 CHROME_CDP_PROXY_PORT=9223 bash /usr/src/app/scripts/start-chrome-cdp.sh &
CDP_PID=$!

# Wait (non-fatal) for the CDP endpoint so Google/Zoom connectOverCDP doesn't race
# a cold Chrome. Teams doesn't need it, so a timeout here is not fatal.
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9223/json/version >/dev/null 2>&1; then
    echo "✓ chrome-cdp ready on :9223"
    break
  fi
  sleep 0.5
done

# ── Teams display :99 (in-container browser draws here; ffmpeg grabs it) ──
Xvfb :99 -screen 0 1280x800x24 &
XVFB_PID=$!
sleep 1

# ── Run the single meeting; the container exits with the worker's exit code ──
DISPLAY=:99 node dist/runOnce.js &
CHILD=$!

# Forward SIGTERM so the bot's graceful shutdown runs (finish the in-flight
# recording) instead of being killed abruptly — matches xvfb-run-wrapper.
trap 'echo "forwarding SIGTERM to worker"; kill -SIGTERM "$CHILD" 2>/dev/null' SIGTERM SIGINT
wait "$CHILD"
CODE=$?

# Best-effort cleanup of the background subsystems (container is about to stop).
kill -TERM "$CDP_PID" "$XVFB_PID" 2>/dev/null || true

echo "Worker finished with exit code $CODE"
exit "$CODE"
