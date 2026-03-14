# One worker avoids cross-worker in-memory state (trigger handshake, caches); file-based trigger store still used if you increase workers later
# gevent-websocket worker required for Flask-SocketIO
web: gunicorn --workers 1 -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker --bind 0.0.0.0:$PORT siteapp:app