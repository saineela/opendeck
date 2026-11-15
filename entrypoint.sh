#!/bin/sh
# Start the bundled PO token provider next to the app.
#
# Label-gated tracks are served only up to about their first megabyte unless the
# googlevideo URL carries a GVS token. The provider that mints them lives in this
# image at /opt/pot-provider; running it on loopback keeps it off the network and
# means no extra container or port mapping is needed.
set -e

if [ -f /opt/pot-provider/build/main.js ]; then
  (cd /opt/pot-provider && node build/main.js --host 127.0.0.1 --port 4416 >/proc/1/fd/1 2>&1) &
  echo "pot-provider: started on 127.0.0.1:4416"
else
  echo "pot-provider: not bundled, playback will fall back to unverified URLs"
fi

exec "$@"
