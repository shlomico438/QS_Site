import ecs_task_protection as prot


class _FakeEcs:
    def __init__(self):
        self.calls = []

    def update_task_protection(self, **kwargs):
        self.calls.append(kwargs)
        return {'protectedTasks': []}


def setup_function():
    prot.reset_ecs_task_protection_cache()


def test_sync_enables_protection_when_a_session_is_active():
    ecs = _FakeEcs()
    prot.sync_ecs_scale_in_protection(
        1,
        ecs_client=ecs,
    )
    # No metadata in tests → no API call unless identity is injected.
    assert ecs.calls == []

    ok = prot.set_ecs_scale_in_protection(
        True,
        cluster='default',
        task_arn='arn:aws:ecs:eu-north-1:123:task/default/abc',
        ecs_client=ecs,
    )
    assert ok is True
    assert ecs.calls[0]['protectionEnabled'] is True
    assert ecs.calls[0]['expiresInMinutes'] == 120
    assert ecs.calls[0]['tasks'] == ['arn:aws:ecs:eu-north-1:123:task/default/abc']


def test_sync_disables_protection_when_sessions_drop_to_zero():
    ecs = _FakeEcs()
    prot.set_ecs_scale_in_protection(
        True,
        cluster='default',
        task_arn='arn:aws:ecs:eu-north-1:123:task/default/abc',
        ecs_client=ecs,
    )
    prot.set_ecs_scale_in_protection(
        False,
        cluster='default',
        task_arn='arn:aws:ecs:eu-north-1:123:task/default/abc',
        ecs_client=ecs,
    )
    assert ecs.calls[-1]['protectionEnabled'] is False
    assert 'expiresInMinutes' not in ecs.calls[-1]


def test_fetch_identity_parses_metadata():
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"Cluster":"default","TaskARN":"arn:aws:ecs:eu-north-1:1:task/default/xyz"}'

    import urllib.request as urllib_request

    orig = urllib_request.urlopen
    urllib_request.urlopen = lambda *a, **k: _Resp()
    try:
        cluster, arn = prot.fetch_ecs_task_identity('http://169.254.170.2/v4/task')
    finally:
        urllib_request.urlopen = orig
    assert cluster == 'default'
    assert arn.endswith('/xyz')
