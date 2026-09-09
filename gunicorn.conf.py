# Gunicorn settings for ECS drain: /health goes 503 on SIGTERM, then the
# worker is given time to finish in-flight polls before SIGKILL.
timeout = 400
graceful_timeout = 60
keepalive = 5


def post_worker_init(worker):
    import signal

    import siteapp

    previous = signal.getsignal(signal.SIGTERM)

    def _on_term(signum, frame):
        siteapp.mark_draining()
        worker.log.warning('SIGTERM received: /health will return 503 (ALB drain)')
        if callable(previous) and previous not in (signal.SIG_DFL, signal.SIG_IGN):
            previous(signum, frame)

    signal.signal(signal.SIGTERM, _on_term)
