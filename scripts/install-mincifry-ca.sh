#!/bin/sh
set -eu

# The TLS endpoint may itself use the Russian trusted chain. The download is
# therefore performed without a pre-existing CA, then pinned to the published
# SHA-256 fingerprint before it is trusted by the image.
CERT_URL="https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt"
EXPECTED_SHA256="D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31"
CERT_TARGET="/usr/local/share/ca-certificates/russian-trusted-root-ca.crt"

temporary_file="$(mktemp)"
trap 'rm -f "$temporary_file"' EXIT

curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  --proto '=https' --tlsv1.2 --insecure \
  --output "$temporary_file" "$CERT_URL"

actual_sha256="$(openssl x509 -in "$temporary_file" -noout -fingerprint -sha256 \
  | cut -d= -f2 | tr -d ':')"

if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "Downloaded Ministry certificate does not match the pinned SHA-256 fingerprint." >&2
  exit 1
fi

install -Dm0644 "$temporary_file" "$CERT_TARGET"
update-ca-certificates
