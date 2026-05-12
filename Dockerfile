# Use the Bun image as the base image
FROM oven/bun:latest

# Set the working directory in the container
WORKDIR /app

# Copy the current directory contents into the container at /app
COPY package*.json bun.lock ./
COPY src ./src

RUN bun install --frozen-lockfile

# Expose the WebSocket relay port
EXPOSE 3055

# Healthcheck — the relay's fetch() handler returns "WebSocket server running"
# for plain HTTP GETs (see src/socket.ts), so we use that as a liveness probe.
# wget is in the bun base image (debian-slim).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://localhost:3055/ || exit 1

# Run the WebSocket relay (long-running service). The MCP server itself
# uses stdio and is meant to be spawned by Cursor/Claude Code, not run as
# a container.
CMD ["bun", "run", "src/socket.ts"]
