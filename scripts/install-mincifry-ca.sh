#!/bin/sh
set -eu

# The TLS endpoint may itself use the Russian trusted chain. The download is
# therefore performed without a pre-existing CA, then pinned to the published
# SHA-256 fingerprint before it is trusted by the image.
ROOT_CERT_URL="https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt"
SUB_CERT_URL="https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt"
EXPECTED_SHA256="D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31"
ROOT_CERT_TARGET="/usr/local/share/ca-certificates/russian-trusted-root-ca.crt"
SUB_CERT_TARGET="/usr/local/share/ca-certificates/russian-trusted-sub-ca.crt"
NODE_CA_BUNDLE="/usr/local/share/ca-certificates/russian-trusted-ca-chain.pem"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
root_certificate="$temporary_directory/root.crt"
sub_certificate="$temporary_directory/sub.crt"

curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  --proto '=https' --tlsv1.2 --insecure \
  --output "$root_certificate" "$ROOT_CERT_URL"

actual_sha256="$(openssl x509 -in "$root_certificate" -noout -fingerprint -sha256 \
  | cut -d= -f2 | tr -d ':')"

if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "Downloaded Ministry certificate does not match the pinned SHA-256 fingerprint." >&2
  exit 1
fi

curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  --proto '=https' --tlsv1.2 --insecure \
  --output "$sub_certificate" "$SUB_CERT_URL"

# The issuing certificate must be signed by the pinned root certificate.
openssl verify -CAfile "$root_certificate" "$sub_certificate"

install -Dm0644 "$root_certificate" "$ROOT_CERT_TARGET"
install -Dm0644 "$sub_certificate" "$SUB_CERT_TARGET"
cat "$root_certificate" "$sub_certificate" > "$NODE_CA_BUNDLE"
update-ca-certificates
