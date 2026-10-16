def post_worker_init(worker):
    # Start one copy of each poller after the single Gunicorn worker has forked.
    from app.main import app
    from app.scheduler import start_workers

    app.extensions["workers_stop"] = start_workers()


def worker_exit(server, worker):
    from app.main import app

    stop = app.extensions.get("workers_stop")
    if stop:
        stop.set()
