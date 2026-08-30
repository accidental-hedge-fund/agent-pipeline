#!/usr/bin/env python3
# Engine-owned child-subreaper for planning-facts providers.
# Node does not expose PR_SET_CHILD_SUBREAPER; this trampoline sets it,
# execs nothing, waits for the inner wrapper, and reaps setsid descendants.
# Nested cgroup.kill is not delegated on GitHub Actions, so this process
# records descendant PIDs from /proc while the inner child is alive and
# SIGKILLs that set after the inner child exits. Reparenting is not required.
import os
import signal
import subprocess
import sys
import threading
import time

try:
    import ctypes
except ImportError:  # pragma: no cover
    ctypes = None

PR_SET_CHILD_SUBREAPER = 36
REAP_GRACE_S = 0.5
REPARENT_WAIT_S = 0.2
SCAN_INTERVAL_S = 0.005


def become_subreaper():
    if ctypes is None:
        return
    try:
        if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            sys.stderr.write("containment: PR_SET_CHILD_SUBREAPER failed\n")
            sys.exit(1)
    except (OSError, AttributeError):
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


def proc_stat_fields(pid):
    try:
        with open("/proc/%d/stat" % pid) as fh:
            st = fh.read()
    except (FileNotFoundError, OSError):
        return None
    comm_end = st.rfind(")")
    if comm_end == -1 or comm_end + 2 >= len(st):
        return None
    return st[comm_end + 2].split()


def proc_state(pid):
    fields = proc_stat_fields(pid)
    if not fields:
        return None
    return fields[0]


def read_ppid(pid):
    fields = proc_stat_fields(pid)
    if not fields or len(fields) < 2:
        return None
    try:
        return int(fields[1])
    except ValueError:
        return None


def collect_descendants(root):
    by_ppid = {}
    try:
        names = os.listdir("/proc")
    except OSError:
        return set()
    for name in names:
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == root:
            continue
        ppid = read_ppid(pid)
        if ppid is None:
            continue
        by_ppid.setdefault(ppid, []).append(pid)
    out = set()
    stack = list(by_ppid.get(root, []))
    while stack:
        pid = stack.pop()
        if pid in out or pid == root:
            continue
        out.add(pid)
        stack.extend(by_ppid.get(pid, []))
    return out


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


def kill_pid(pid):
    if pid <= 1 or pid == os.getpid():
        return
    for target in (-pid, pid):
        try:
            os.kill(target, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def kill_pids(pids):
    for pid in pids:
        kill_pid(pid)


def reap_remaining():
    reparent_deadline = time.monotonic() + REPARENT_WAIT_S
    while time.monotonic() < reparent_deadline:
        reap_zombies()
        if live_child_pids():
            break
        time.sleep(SCAN_INTERVAL_S)
    deadline = time.monotonic() + REAP_GRACE_S
    while True:
        reap_zombies()
        live = live_child_pids()
        if not live:
            reap_zombies()
            return True
        if time.monotonic() >= deadline:
            kill_pids(live)
            reap_zombies()
            return not live_child_pids()
        kill_pids(live)
        time.sleep(SCAN_INTERVAL_S)


def start_tracker(known):
    self_pid = os.getpid()
    stop = threading.Event()

    def scan():
        while not stop.is_set():
            known.update(collect_descendants(self_pid))
            time.sleep(SCAN_INTERVAL_S)

    thread = threading.Thread(target=scan, daemon=True)
    thread.start()
    return stop, thread, self_pid


def stop_tracker(stop, thread, known, self_pid, inner_pid):
    deadline = time.monotonic() + REPARENT_WAIT_S
    while time.monotonic() < deadline:
        known.update(collect_descendants(self_pid))
        known.update(live_child_pids())
        time.sleep(SCAN_INTERVAL_S)
    stop.set()
    thread.join(timeout=REAP_GRACE_S)
    known.discard(self_pid)
    if inner_pid:
        known.discard(inner_pid)


def terminate_tree(child, known):
    if child.poll() is None:
        try:
            child.kill()
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=REAP_GRACE_S)
        except subprocess.TimeoutExpired:
            pass
    known.update(collect_descendants(os.getpid()))
    known.update(live_child_pids())
    known.discard(os.getpid())
    if child.pid:
        known.discard(child.pid)
    kill_pids(known)
    reap_remaining()


def main():
    become_subreaper()
    if len(sys.argv) < 2:
        sys.stderr.write("containment: subreaper argv is malformed\n")
        sys.exit(1)
    known = set()
    stop, thread, self_pid = start_tracker(known)
    child = subprocess.Popen(sys.argv[1:], start_new_session=False)

    def on_term(_signum, _frame):
        stop_tracker(stop, thread, known, self_pid, child.pid)
        terminate_tree(child, known)
        sys.exit(1)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    code = child.wait()
    stop_tracker(stop, thread, known, self_pid, child.pid)
    kill_pids(known)
    if not reap_remaining():
        sys.exit(1)
    sys.exit(code if code is not None else 1)


if __name__ == "__main__":
    main()
