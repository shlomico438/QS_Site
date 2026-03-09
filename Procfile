# One worker avoids cross-worker in-memory state (trigger handshake, caches); file-based trigger store still used if you increase workers later
web: gunicorn --workers 1 --bind :$PORT siteapp:app