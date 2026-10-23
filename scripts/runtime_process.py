"""Process liveness on Windows and Linux, without treating access denial as death."""
import os


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError('PID pekerja tidak valid.')
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if handle:
            kernel.CloseHandle(handle)
            return True
        if ctypes.get_last_error() in (87, 1168):
            return False
        raise RuntimeError('Status proses lama belum dapat dipastikan.')
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
