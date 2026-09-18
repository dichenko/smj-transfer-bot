# Add this site block to the shared Caddyfile on the VPS.
# Caddy obtains and renews the public TLS certificate automatically.
transfer.smjrfrb.ru {
	encode zstd gzip

	handle /max/webhook {
		reverse_proxy 127.0.0.1:3600
	}

	handle {
		respond "not found" 404
	}
}
