#!/bin/sh
set -eu

# The Docker socket's numeric group differs between hosts. Create or reuse a
# matching group inside the container, then add node to it before dropping
# privileges. This keeps Docker socket access working without hard-coding a GID.
if [ -S /var/run/docker.sock ]; then
  docker_gid="$(stat -c '%g' /var/run/docker.sock)"
  docker_group="$(awk -F: -v gid="$docker_gid" '$3 == gid { print $1; exit }' /etc/group)"

  if [ -z "$docker_group" ]; then
    docker_group=hostdocker
    addgroup -S -g "$docker_gid" "$docker_group"
  fi

  addgroup node "$docker_group" >/dev/null 2>&1 || true
else
  echo "WARNING: /var/run/docker.sock is not mounted; stack controls will fail." >&2
fi

exec su-exec node "$@"
