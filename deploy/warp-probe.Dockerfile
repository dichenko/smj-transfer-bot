FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gpg iproute2 python3 \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg -o /tmp/cloudflare-warp.gpg \
    && gpg --dearmor -o /usr/share/keyrings/cloudflare-warp.gpg /tmp/cloudflare-warp.gpg \
    && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-warp.gpg] https://pkg.cloudflareclient.com/ bookworm main' > /etc/apt/sources.list.d/cloudflare-warp.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflare-warp \
    && rm -rf /tmp/cloudflare-warp.gpg /var/lib/apt/lists/*

COPY --chmod=0755 deploy/probe-cloudflare-warp.sh /usr/local/bin/probe-cloudflare-warp
ENTRYPOINT ["/usr/local/bin/probe-cloudflare-warp"]
