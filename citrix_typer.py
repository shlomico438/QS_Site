"""Type finalized QuickScribe medical transcript text into a focused Citrix window.

Listens on Socket.IO polling for ``medical_transcribe_event`` messages whose
``type`` is ``final``. Those are newly frozen ASR phrases, not interim partials.
Paste uses the clipboard and Ctrl+V. The previous clipboard is restored after
each paste.

No Citrix session was open on the machine this was written against, so the
window title is not guessed. Pass the real title substring from Alt-Tab:

    python citrix_typer.py --list-windows
    python citrix_typer.py --window "Your Citrix title" --token-file token.txt
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from collections import deque

import socketio


def split_final_words(text: str) -> list[str]:
    """Paste units. AWS freezes short phrases; each word is pasted with a space."""
    parts = str(text or '').split()
    return [part + ' ' for part in parts if part]


def citrix_window_matches(title: str, needle: str) -> bool:
    hay = str(title or '').casefold()
    key = str(needle or '').strip().casefold()
    return bool(key) and key in hay


class Win32Ui:
    """Foreground window, clipboard, and Ctrl+V. Windows only."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self._ctypes = ctypes
        self._user32 = ctypes.windll.user32
        self._kernel32 = ctypes.windll.kernel32
        self._wintypes = wintypes
        self._user32.GetForegroundWindow.restype = wintypes.HWND
        self._user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        self._user32.GetWindowTextLengthW.restype = ctypes.c_int
        self._user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self._user32.GetWindowTextW.restype = ctypes.c_int
        self._user32.IsWindowVisible.argtypes = [wintypes.HWND]
        self._user32.IsWindowVisible.restype = wintypes.BOOL
        self._user32.EnumWindows.argtypes = [
            ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM),
            wintypes.LPARAM,
        ]
        self._user32.EnumWindows.restype = wintypes.BOOL
        self._user32.OpenClipboard.argtypes = [wintypes.HWND]
        self._user32.OpenClipboard.restype = wintypes.BOOL
        self._user32.CloseClipboard.restype = wintypes.BOOL
        self._user32.EmptyClipboard.restype = wintypes.BOOL
        self._user32.GetClipboardData.argtypes = [wintypes.UINT]
        self._user32.GetClipboardData.restype = ctypes.c_void_p
        self._user32.SetClipboardData.argtypes = [wintypes.UINT, ctypes.c_void_p]
        self._user32.SetClipboardData.restype = ctypes.c_void_p
        self._kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        self._kernel32.GlobalAlloc.restype = ctypes.c_void_p
        self._kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
        self._kernel32.GlobalLock.restype = ctypes.c_void_p
        self._kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
        self._kernel32.GlobalUnlock.restype = wintypes.BOOL
        self._kernel32.GlobalSize.argtypes = [ctypes.c_void_p]
        self._kernel32.GlobalSize.restype = ctypes.c_size_t

    def foreground_title(self) -> str:
        hwnd = self._user32.GetForegroundWindow()
        return self._window_title(hwnd)

    def list_titles(self) -> list[str]:
        titles: list[str] = []

        @self._ctypes.WINFUNCTYPE(self._wintypes.BOOL, self._wintypes.HWND, self._wintypes.LPARAM)
        def _cb(hwnd, _lparam):
            if self._user32.IsWindowVisible(hwnd):
                title = self._window_title(hwnd).strip()
                if title:
                    titles.append(title)
            return True

        self._user32.EnumWindows(_cb, 0)
        return titles

    def _window_title(self, hwnd) -> str:
        if not hwnd:
            return ''
        length = int(self._user32.GetWindowTextLengthW(hwnd) or 0)
        if length <= 0:
            return ''
        buf = self._ctypes.create_unicode_buffer(length + 1)
        self._user32.GetWindowTextW(hwnd, buf, length + 1)
        return str(buf.value or '')

    def paste_text(self, text: str, *, key_by_key: bool) -> None:
        if key_by_key:
            self._type_chars(text)
            return
        previous = self._swap_clipboard(text)
        try:
            self._send_ctrl_v()
            time.sleep(0.2)
        finally:
            self._restore_clipboard(previous)

    def _swap_clipboard(self, text: str):
        ctypes = self._ctypes
        user32 = self._user32
        kernel32 = self._kernel32
        CF_UNICODETEXT = 13
        GMEM_MOVEABLE = 0x0002
        if not self._open_clipboard():
            raise OSError('OpenClipboard failed')
        try:
            previous = self._read_unicode_clipboard()
            user32.EmptyClipboard()
            data = str(text).encode('utf-16-le') + b'\x00\x00'
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            if not handle:
                raise OSError('GlobalAlloc failed')
            locked = kernel32.GlobalLock(handle)
            if not locked:
                raise OSError('GlobalLock failed')
            ctypes.memmove(locked, data, len(data))
            kernel32.GlobalUnlock(handle)
            if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                raise OSError('SetClipboardData failed')
            return previous
        finally:
            user32.CloseClipboard()

    def _restore_clipboard(self, previous) -> None:
        if previous is None:
            return
        user32 = self._user32
        kernel32 = self._kernel32
        ctypes = self._ctypes
        CF_UNICODETEXT = 13
        GMEM_MOVEABLE = 0x0002
        if not self._open_clipboard():
            return
        try:
            user32.EmptyClipboard()
            data = str(previous).encode('utf-16-le') + b'\x00\x00'
            handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            if not handle:
                return
            locked = kernel32.GlobalLock(handle)
            if not locked:
                return
            ctypes.memmove(locked, data, len(data))
            kernel32.GlobalUnlock(handle)
            user32.SetClipboardData(CF_UNICODETEXT, handle)
        finally:
            user32.CloseClipboard()

    def _open_clipboard(self) -> bool:
        for _ in range(8):
            if self._user32.OpenClipboard(None):
                return True
            time.sleep(0.05)
        return False

    def _send_ctrl_v(self) -> None:
        user32 = self._user32
        KEYEVENTF_KEYUP = 0x0002
        VK_CONTROL = 0x11
        VK_V = 0x56
        user32.keybd_event.argtypes = [
            self._wintypes.BYTE,
            self._wintypes.BYTE,
            self._wintypes.DWORD,
            self._ctypes.c_size_t,
        ]
        user32.keybd_event.restype = None
        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        user32.keybd_event(VK_V, 0, 0, 0)
        user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)

    def _input_type(self):
        ctypes = self._ctypes
        wintypes = self._wintypes
        if getattr(self, '_INPUT', None) is not None:
            return self._INPUT

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ('wVk', wintypes.WORD),
                ('wScan', wintypes.WORD),
                ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.c_size_t),
            ]

        class INPUTUNION(ctypes.Union):
            _fields_ = [('ki', KEYBDINPUT)]

        class INPUT(ctypes.Structure):
            _anonymous_ = ('u',)
            _fields_ = [('type', wintypes.DWORD), ('u', INPUTUNION)]

        self._user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        self._user32.SendInput.restype = wintypes.UINT
        self._INPUT = INPUT
        self._KEYBDINPUT = KEYBDINPUT
        return INPUT

    def _send_inputs(self, events) -> None:
        INPUT = self._input_type()
        seq = (INPUT * len(events))(*events)
        sent = self._user32.SendInput(len(events), seq, self._ctypes.sizeof(INPUT))
        if sent != len(events):
            err = self._kernel32.GetLastError()
            raise OSError(f'SendInput failed ({sent}/{len(events)}, error {err})')

    def _send_ctrl_v_raw(self) -> None:
        INPUT_KEYBOARD = 1
        KEYEVENTF_KEYUP = 0x0002
        VK_CONTROL = 0x11
        VK_V = 0x56
        self._input_type()
        KEYBDINPUT = self._KEYBDINPUT

        def _key(vk, flags=0):
            return self._INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(vk, 0, flags, 0, 0))

        self._send_inputs((
            _key(VK_CONTROL),
            _key(VK_V),
            _key(VK_V, KEYEVENTF_KEYUP),
            _key(VK_CONTROL, KEYEVENTF_KEYUP),
        ))

    def _type_chars(self, text: str) -> None:
        """Fallback for a field that ignores Ctrl+V. Slow on purpose for ICA latency."""
        try:
            import pydirectinput
            pydirectinput.PAUSE = 0.03
            typer = pydirectinput
        except Exception:
            typer = None
        for ch in str(text):
            if typer is not None:
                if ch == ' ':
                    typer.press('space')
                elif ch == '\n':
                    typer.press('enter')
                else:
                    typer.write(ch)
            else:
                self._send_unicode_char(ch)
            time.sleep(0.04)

    def _send_unicode_char(self, ch: str) -> None:
        INPUT_KEYBOARD = 1
        KEYEVENTF_UNICODE = 0x0004
        KEYEVENTF_KEYUP = 0x0002
        self._input_type()
        KEYBDINPUT = self._KEYBDINPUT
        scan = ord(ch)
        down = self._INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, scan, KEYEVENTF_UNICODE, 0, 0))
        up = self._INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0))
        self._send_inputs((down, up))


    def _read_unicode_clipboard(self):
        CF_UNICODETEXT = 13
        handle = self._user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        locked = self._kernel32.GlobalLock(handle)
        if not locked:
            return None
        try:
            size = int(self._kernel32.GlobalSize(handle) or 0)
            if size < 2:
                return None
            raw = self._ctypes.string_at(locked, size)
            return raw.decode('utf-16-le', errors='ignore').split('\x00', 1)[0]
        except OSError:
            return None
        finally:
            self._kernel32.GlobalUnlock(handle)


class CitrixTyper:
    def __init__(self, ui: Win32Ui, window_needle: str, *, key_by_key: bool = False, word_delay: float = 0.04):
        self.ui = ui
        self.window_needle = window_needle
        self.key_by_key = key_by_key
        self.word_delay = max(0.0, float(word_delay))
        self._queue: deque[str] = deque()
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def focused(self) -> bool:
        return citrix_window_matches(self.ui.foreground_title(), self.window_needle)

    def enqueue_final(self, text: str) -> None:
        words = split_final_words(text)
        if not words:
            return
        with self._lock:
            self._queue.extend(words)

    def run(self) -> None:
        while not self._stop.is_set():
            if not self.focused():
                time.sleep(0.15)
                continue
            with self._lock:
                word = self._queue.popleft() if self._queue else ''
            if not word:
                time.sleep(0.05)
                continue
            if not self.focused():
                with self._lock:
                    self._queue.appendleft(word)
                continue
            try:
                self.ui.paste_text(word, key_by_key=self.key_by_key)
            except Exception as exc:
                print('paste failed:', exc, file=sys.stderr, flush=True)
                continue
            if self.word_delay:
                time.sleep(self.word_delay)

    def stop(self) -> None:
        self._stop.set()


def build_client(url: str, token: str, typer: CitrixTyper) -> socketio.Client:
    sio = socketio.Client(
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=1,
        reconnection_delay_max=10,
        logger=False,
        engineio_logger=False,
    )

    @sio.event
    def connect():
        print('socket connected; joining finalized-text room', flush=True)
        sio.emit('medical_transcribe_watch', {'access_token': token})
        sio._qs_watch_sent = time.time()

    @sio.on('medical_transcribe_event')
    def on_event(msg):
        if not isinstance(msg, dict):
            return
        kind = str(msg.get('type') or '')
        if kind == 'watching':
            sio._qs_watching = True
            print('watching finalized medical transcript', flush=True)
            return
        if kind == 'error':
            sio._qs_watch_error = str(msg.get('error') or 'watch_rejected')
            print('watch rejected:', sio._qs_watch_error, file=sys.stderr, flush=True)
            return
        if kind != 'final':
            return
        text = str(msg.get('text') or '')
        if text.strip():
            typer.enqueue_final(text)
            print('final:', text.strip(), flush=True)

    sio.connect(
        url,
        transports=['polling'],
        socketio_path='socket.io',
        wait_timeout=30,
    )
    return sio


def _read_token(args) -> str:
    if args.token:
        raw = str(args.token)
    elif args.token_file:
        with open(args.token_file, 'r', encoding='utf-8-sig') as handle:
            raw = handle.read()
    else:
        raw = str(os.environ.get('QS_ACCESS_TOKEN') or '')
    return _access_token_from_text(raw)


def _access_token_from_text(raw: str) -> str:
    text = str(raw or '').strip().strip('"').strip("'")
    if text.lower().startswith('bearer '):
        text = text[7:].strip()
    if text.startswith('{'):
        try:
            import json
            data = json.loads(text)
            if isinstance(data, dict):
                text = str(
                    data.get('access_token')
                    or (data.get('currentSession') or {}).get('access_token')
                    or ''
                ).strip()
        except Exception:
            return ''
    return text


def _token_expired(token: str) -> bool:
    parts = str(token or '').split('.')
    if len(parts) != 3:
        return False
    try:
        import base64
        import json
        payload = parts[1]
        payload += '=' * ((4 - len(payload) % 4) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload.encode('ascii')))
        exp = int(data.get('exp') or 0)
    except Exception:
        return False
    return bool(exp) and exp < time.time()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Type finalized QuickScribe medical text into Citrix.')
    parser.add_argument('--url', default=os.environ.get('QS_SITE_URL') or 'https://www.getquickscribe.com')
    parser.add_argument('--token', default='')
    parser.add_argument('--token-file', default='')
    parser.add_argument('--window', default=os.environ.get('QS_CITRIX_WINDOW') or '',
                        help='Substring of the real Citrix window title (Alt-Tab / --list-windows).')
    parser.add_argument('--list-windows', action='store_true')
    parser.add_argument('--keys', action='store_true',
                        help='Type character by character. Use only if the EHR field ignores Ctrl+V.')
    parser.add_argument('--word-delay', type=float, default=0.04)
    args = parser.parse_args(argv)

    if sys.platform != 'win32':
        print('citrix_typer.py runs on Windows.', file=sys.stderr)
        return 2
    ui = Win32Ui()
    if args.list_windows:
        for title in ui.list_titles():
            print(title)
        return 0
    if not str(args.window or '').strip():
        print('Pass --window with the Citrix title substring. Use --list-windows to see titles.', file=sys.stderr)
        return 2
    token = _read_token(args)
    if not token:
        print('Pass --token, --token-file, or QS_ACCESS_TOKEN (the signed-in Supabase access token).', file=sys.stderr)
        return 2
    if _token_expired(token):
        print(
            'token.txt is expired. On the signed-in medical page, run this in the browser console '
            'and paste the copied value into token.txt:\n'
            'copy((await supabase.auth.getSession()).data.session.access_token)',
            file=sys.stderr,
        )
        return 2

    print('Connecting to', args.url, flush=True)
    print('Ctrl+C stops the typer.', flush=True)
    typer = CitrixTyper(ui, args.window, key_by_key=bool(args.keys), word_delay=args.word_delay)
    worker = threading.Thread(target=typer.run, name='citrix-typer', daemon=True)
    worker.start()
    client = build_client(args.url, token, typer)
    print('Typer running. Click in Notepad++ (or the Citrix field) before you pause.', flush=True)
    watched = False
    try:
        while True:
            time.sleep(0.2)
            if getattr(client, '_qs_watch_error', ''):
                if client._qs_watch_error == 'medical_auth_invalid':
                    print(
                        'The server rejected this access token. Copy a fresh one from the signed-in page:\n'
                        'copy((await supabase.auth.getSession()).data.session.access_token)',
                        file=sys.stderr,
                        flush=True,
                    )
                return 2
            if not watched and getattr(client, '_qs_watching', False):
                watched = True
            if not watched and time.time() - float(getattr(client, '_qs_watch_sent', time.time())) > 8:
                print(
                    'This server did not accept the watch. For the local simulation site, stop this '
                    'and rerun with --url http://127.0.0.1:8000 after restarting that server.',
                    file=sys.stderr,
                    flush=True,
                )
                return 2
    except KeyboardInterrupt:
        print('Stopping.', flush=True)
    finally:
        typer.stop()
        try:
            client.disconnect()
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
