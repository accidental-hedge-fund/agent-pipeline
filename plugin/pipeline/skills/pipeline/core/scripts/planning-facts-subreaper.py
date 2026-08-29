#!/usr/bin/env python3
# Engine-owned child-subreaper for planning-facts providers.
# Node does not expose PR_SET_CHILD_SUBREAPER; this trampoline sets it,
# execs nothing, waits for the inner wrapper, and reaps setsid descendants.
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
REAP_GRACE_S = 0.4


def become_subreaper():
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        sys.stderr.write("containment: PR_SET_CHILD_SUBREAPER failed\n")
        sys.exit(1)


def child_pids():
    pids = set()
    task = "/proc/%d/task" % os.getpid()
    try:
        tids = os.listdir(task)
    except FileNotFoundError:
        return []
    for tid in tids:
        try:
            with open("%s/%s/children" % (task, tid)) as fh:
                for tok in fh.read().split():
                    n = int(tok)
                    if n > 0:
                        pids.add(n)
        except (FileNotFoundError, ValueError, OSError):
            continue
    return list(pids)


def proc_state(pid):
    try:
        with open("/proc/%d/stat" % pid) as fh:
            st = fh.read()
    except (FileNotFoundError, OSError):
        return None
    comm_end = st.rfind(")")
    if comm_end == -1 or comm_end + 2 >= len(st):
        return None
    return st[comm_end + 2]


def live_child_pids():
    live = []
    for pid in child_pids():
        state = proc_state(pid)
        if state is None or state == "Z":
            continue
        live.append(pid)
    return live


def reap_zombies():
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def kill_live_children():
    for pid in live_child_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main():
    become_subreaper()
    if len(sys.argv) < 2:
        sys.stderr.write("containment: subreaper argv is malformed\n")
        sys.exit(1)
    child = subprocess.Popen(sys.argv[1:], start_new_session=False)

    def on_term(_signum, _frame):
        if child.poll() is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
        kill_live_children()
        reap_zombies()
        sys.exit(1)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    code = child.wait()
    deadline = time.monotonic() + REAP_GRACE_S
    while True:
        reap_zombies()
        live = live_child_pids()
        if not live:
            break
        if time.monotonic() >= deadline:
            sys.exit(1)
        kill_live_children()
        time.sleep(0.01)
    reap_zombies()
    sys.exit(code if code is not None else 1)


if __name__ == "__main__":
    main()
