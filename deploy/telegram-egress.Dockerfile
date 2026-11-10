FROM aiogram/telegram-bot-api@sha256:fd8fc7475af6a552dc74b4e587428c71565bfa3fde66ec612a77ea5e287f21ac

USER root
RUN apk add --no-cache bash ca-certificates curl iptables openssh-client python3 su-exec \
    && apk add --no-cache --virtual .build-deps py3-pip \
    && python3 -m venv /opt/sshuttle \
    && printf '%s\n' 'sshuttle==1.3.2 --hash=sha256:022c5df2d9fd31cd6216eabc24d2754c1adb0b9878fff43c4b8f84d89aa6634c' > /tmp/requirements.txt \
    && /opt/sshuttle/bin/pip install --no-cache-dir --no-deps --only-binary=:all: --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && apk del .build-deps

COPY --chmod=0755 deploy/start-telegram-egress.sh /usr/local/bin/start-telegram-egress
COPY deploy/telegram-ipv4.txt /etc/telegram-ipv4.txt
