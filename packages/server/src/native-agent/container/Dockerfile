FROM node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY guard.c /guard.c
RUN gcc -O2 -Wall -Wextra -Werror /guard.c -o /guard

FROM node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=build /guard /usr/local/bin/guanxi-exec-guard
