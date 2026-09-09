FROM python:3.11.9-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=10001:10001 . .

RUN mkdir -p /tmp/quickscribe \
    && chown -R 10001:10001 /app /tmp/quickscribe

USER 10001:10001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/health', timeout=8).read()" || exit 1

# Keep one worker: the application currently has process-local job/cache state.
# gevent-websocket is required by Flask-SocketIO.
CMD ["sh", "-c", "exec gunicorn --workers 1 --no-control-socket -c gunicorn.conf.py -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker --bind 0.0.0.0:${PORT:-8000} siteapp:app"]
