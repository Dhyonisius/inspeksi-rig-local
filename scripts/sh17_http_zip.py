"""Read SH17 ZIP metadata and label blocks using ordinary HTTP range requests."""
import io
import os
from pathlib import Path
import re
import urllib.request
import uuid

class HttpZipReader(io.RawIOBase):
    def __init__(self, url, cache_directory, block_size=2 * 1024**2):
        self.url = url
        self.cache = Path(cache_directory)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.block_size = block_size
        self.position = 0
        request = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            value = response.headers.get("Content-Range", "")
            if response.status != 206 or not re.fullmatch(r"bytes 0-0/[0-9]+", value):
                raise RuntimeError("Sumber ZIP tidak menyediakan rentang HTTP.")
            self.length = int(value.split("/")[-1])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset if whence == 0 else self.position+offset if whence == 1 else self.length+offset
        if position < 0:
            raise ValueError("Posisi ZIP tidak valid.")
        self.position = position
        return position

    def read(self, size=-1):
        if size is None or size < 0:
            size = self.length-self.position
        size = min(size, max(0, self.length-self.position))
        if size > 64 * 1024**2:
            raise ValueError("Pembacaan metadata ZIP melebihi batas.")
        result = bytearray()
        while size:
            index = self.position // self.block_size
            start = index*self.block_size
            end = min(self.length-1, start+self.block_size-1)
            file = self.cache / f"{index:06d}.bin"
            if not file.exists() or file.stat().st_size != end-start+1:
                request = urllib.request.Request(self.url, headers={"Range": f"bytes={start}-{end}"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{self.length}":
                        raise RuntimeError("Sumber memberikan rentang ZIP yang tidak sesuai.")
                    binary = response.read(end-start+1)
                    if len(binary) != end-start+1:
                        raise RuntimeError("Metadata ZIP belum lengkap.")
                    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
                    temporary.write_bytes(binary)
                    os.replace(temporary, file)
            else:
                binary = file.read_bytes()
            if len(binary) != end-start+1:
                raise RuntimeError("Blok ZIP lokal belum lengkap.")
            local_start = self.position-start
            length = min(size, len(binary)-local_start)
            if length <= 0:
                raise RuntimeError("Rentang ZIP lokal tidak valid.")
            result.extend(binary[local_start:local_start+length])
            self.position += length
            size -= length
        return bytes(result)
