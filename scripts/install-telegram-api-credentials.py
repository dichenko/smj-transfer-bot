"""Read api_id/api_hash JSON from stdin and update the server's private .env."""
import json
import os
from pathlib import Path
import re
import sys

values = json.load(sys.stdin)
api_id = str(values['TELEGRAM_API_ID']).strip()
api_hash = str(values['TELEGRAM_API_HASH']).strip()
if not re.fullmatch(r'\d+', api_id) or not re.fullmatch(r'[0-9a-fA-F]{32}', api_hash):
    raise ValueError('Invalid Telegram API credentials')

path = Path('/opt/smj-transfer-bot/.env')
lines = path.read_text().splitlines()
updates = {
    'TELEGRAM_API_ID': api_id,
    'TELEGRAM_API_HASH': api_hash,
    'TELEGRAM_API_ROOT': 'http://telegram-api:8081',
}
lines = [line for line in lines if not any(line.startswith(f'{key}=') for key in updates)]
lines.extend(f'{key}={value}' for key, value in updates.items())
temp = path.with_suffix('.env.tmp')
temp.write_text('\n'.join(lines) + '\n')
os.chmod(temp, 0o600)
os.replace(temp, path)
print('Telegram API settings installed in server .env')
