# -*- coding: utf-8 -*-
# 小鲸鱼 · 桌面应用（Qt WebEngine 窗口 + 本机聊天服务）
import os
import pathlib
import socket
import subprocess
import sys
import time

os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")

from PySide6.QtCore import QUrl
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication, QMainWindow
from PySide6.QtWebEngineWidgets import QWebEngineView

PORT = 3222


def app_dir() -> pathlib.Path:
    if getattr(sys, "frozen", False):
        return pathlib.Path(sys.executable).resolve().parent
    return pathlib.Path(__file__).resolve().parent


AD = app_dir()
SERVER = AD / "server"
NODE = AD / "node.exe"
if not NODE.exists():
    NODE = pathlib.Path("node")  # 没打包 node 时用系统 PATH 里的


def port_open() -> bool:
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def start_server():
    if port_open():
        return None
    try:
        (SERVER / "data").mkdir(parents=True, exist_ok=True)
        log = open(SERVER / "data" / "server.out.log", "a", encoding="utf-8")
        p = subprocess.Popen(
            [str(NODE), str(SERVER / "server.mjs")],
            cwd=str(SERVER),
            stdout=log,
            stderr=log,
            creationflags=0x08000000,
        )
    except Exception:
        return None
    for _ in range(40):
        if port_open():
            break
        time.sleep(0.5)
    return p


def read_token() -> str:
    try:
        return (SERVER / "data" / "token.txt").read_text(encoding="utf-8").strip()
    except Exception:
        return ""


proc = start_server()
token = read_token()

app = QApplication(sys.argv)
app.setApplicationName("小鲸鱼")
win = QMainWindow()
win.setWindowTitle("小鲸鱼")
win.resize(430, 860)
win.setMinimumSize(360, 560)
ico = AD / "icon.ico"
if ico.exists():
    win.setWindowIcon(QIcon(str(ico)))

view = QWebEngineView(win)
view.load(QUrl(f"http://127.0.0.1:{PORT}/?k={token}"))
win.setCentralWidget(view)
win.show()
app.exec()

if proc is not None:
    try:
        proc.terminate()
    except Exception:
        pass
