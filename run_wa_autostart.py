"""
Peluncur autostart untuk WA Scheduler (menjalankan index.js dengan Node).

Dipanggil oleh Windows Task Scheduler saat server boot.

Kenapa tidak langsung menjalankan start.bat:
  start.bat diakhiri "pause". Kalau node berhenti, cmd menunggu tombol
  ditekan -- dan itu tidak akan pernah terjadi saat jalan otomatis. Akibatnya
  task tetap berstatus Running selamanya dan fitur "restart kalau gagal"
  tidak pernah aktif, jadi bot tinggal mati. start.bat TIDAK diubah dan
  tetap bisa dipakai manual dengan dobel-klik.

Yang dilakukan peluncur ini:
  1. memaksa working directory = folder ini
     (index.js memakai path relatif './auth', './reminders.json', dll)
  2. mencegah dua instance berjalan bersamaan
     (index.js TIDAK punya pengaman ini; dua sesi Baileys dengan creds
      yang sama akan saling tendang dan bisa memaksa logout WhatsApp)
  3. menyimpan output node ke logs\stdout_YYYYMMDD.log

index.js, start.bat, dan folder auth\ TIDAK diubah sama sekali.
"""

import ctypes
import os
import shutil
import subprocess
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(BASE, "index.js")
LOCK = os.path.join(BASE, "wa.lock")
LOGDIR = os.path.join(BASE, "logs")

# Urutan pencarian: instalasi resmi dulu, baru lewat PATH.
NODE_CANDIDATES = [
    r"C:\Program Files\nodejs\node.exe",
    r"C:\Program Files (x86)\nodejs\node.exe",
]

STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def hidup(pid):
    """True kalau PID masih benar-benar berjalan (bukan sisa proses mati)."""
    h = ctypes.windll.kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not h:
        return False
    try:
        kode = ctypes.c_ulong()
        ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(kode))
        return bool(ok) and kode.value == STILL_ACTIVE
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


def cari_node():
    for c in NODE_CANDIDATES:
        if os.path.isfile(c):
            return c
    menemukan = shutil.which("node")
    return menemukan


def baca_lock():
    try:
        with open(LOCK, "r", encoding="utf-8") as f:
            return int(f.read().strip())
    except Exception:
        return None


def main():
    os.chdir(BASE)
    os.makedirs(LOGDIR, exist_ok=True)
    logpath = os.path.join(LOGDIR, "stdout_%s.log" % datetime.now().strftime("%Y%m%d"))

    def catat(pesan):
        with open(logpath, "a", encoding="utf-8", errors="replace") as f:
            f.write("[%s] %s\n" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), pesan))

    # ---- 1. pengaman single-instance ----
    pid_lama = baca_lock()
    if pid_lama and hidup(pid_lama):
        catat("DIBATALKAN: WA Scheduler sudah berjalan (PID %d)." % pid_lama)
        print("WA Scheduler sudah berjalan (PID %d)." % pid_lama)
        return 0
    if pid_lama:
        catat("Lock basi dari PID %d (proses sudah mati) -- dibersihkan." % pid_lama)

    # ---- 2. cari node & entry point ----
    node = cari_node()
    if not node:
        catat("GAGAL: node.exe tidak ditemukan.")
        print("node.exe tidak ditemukan.")
        return 1
    if not os.path.isfile(ENTRY):
        catat("GAGAL: %s tidak ditemukan." % ENTRY)
        print("index.js tidak ditemukan.")
        return 1

    with open(LOCK, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))

    catat("=" * 60)
    catat("MENJALANKAN index.js | node=%s | peluncur PID %d | cwd %s"
          % (node, os.getpid(), BASE))

    kode = 1
    try:
        with open(logpath, "a", encoding="utf-8", errors="replace") as logf:
            proses = subprocess.Popen(
                [node, ENTRY],
                cwd=BASE,
                stdout=logf,
                stderr=subprocess.STDOUT,
            )
            kode = proses.wait()
        catat("index.js BERHENTI dengan kode %s" % kode)
    except Exception as e:
        catat("GAGAL menjalankan index.js: %r" % (e,))
    finally:
        try:
            os.remove(LOCK)
        except OSError:
            pass

    return kode if isinstance(kode, int) else 1


if __name__ == "__main__":
    sys.exit(main())
