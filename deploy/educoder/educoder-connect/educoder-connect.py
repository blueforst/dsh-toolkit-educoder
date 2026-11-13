#!/usr/bin/env python3
"""仅向指定 DSH 宿主开放 EduCoder TLS 隧道。"""

import argparse
import asyncio
import contextlib
import ipaddress
import socket

HTTPS_PORT = 443
DESTINATIONS = {
    b"data.educoder.net:443": "data.educoder.net",
    b"www.educoder.net:443": "www.educoder.net",
    b"www-cdn.educoder.net:443": "www-cdn.educoder.net",
    b"webssh.educoder.net:443": "webssh.educoder.net",
    b"prod-attachments.oss-accelerate.aliyuncs.com:443": "prod-attachments.oss-accelerate.aliyuncs.com",
}
HEADER_LIMIT = 8192
MAX_CONNECTIONS = 128
TUNNEL_TIMEOUT = 600
CONNECT_TIMEOUT = 20
DNS_RETRY_DELAY = 0.15
ADDRESS_CONNECT_TIMEOUT = 8


async def connect_educoder(destination):
    loop = asyncio.get_running_loop()
    tried = set()
    for attempt in range(2):
        if attempt:
            await asyncio.sleep(DNS_RETRY_DELAY)
        try:
            results = await loop.getaddrinfo(
                destination, HTTPS_PORT, family=socket.AF_INET, type=socket.SOCK_STREAM
            )
        except OSError:
            continue
        for address in dict.fromkeys(result[4][0] for result in results):
            if address in tried or not ipaddress.ip_address(address).is_global:
                continue
            tried.add(address)
            try:
                return await asyncio.wait_for(
                    asyncio.open_connection(address, HTTPS_PORT), timeout=ADDRESS_CONNECT_TIMEOUT
                )
            except (OSError, TimeoutError):
                continue
    raise OSError("EduCoder 不可达")


async def copy_stream(reader, writer):
    while data := await asyncio.wait_for(reader.read(32768), TUNNEL_TIMEOUT):
        writer.write(data)
        await asyncio.wait_for(writer.drain(), TUNNEL_TIMEOUT)


async def serve(bind, port, peer):
    active = 0

    async def handle(reader, client):
        nonlocal active
        address = client.get_extra_info("peername")
        if not address or address[0] != peer or active >= MAX_CONNECTIONS:
            client.close()
            return
        active += 1
        upstream = None
        pumps = set()
        try:
            try:
                header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
                method, target, protocol = header.split(b"\r\n", 1)[0].split(b" ")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, ValueError):
                client.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                return
            destination = DESTINATIONS.get(target)
            if (method != b"CONNECT" or destination is None
                    or protocol not in (b"HTTP/1.0", b"HTTP/1.1")):
                client.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                return
            try:
                incoming, upstream = await asyncio.wait_for(connect_educoder(destination), CONNECT_TIMEOUT)
            except (OSError, TimeoutError):
                client.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                return
            client.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await client.drain()
            pumps = {
                asyncio.create_task(copy_stream(reader, upstream)),
                asyncio.create_task(copy_stream(incoming, client)),
            }
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        except (OSError, TimeoutError):
            pass
        finally:
            for pump in pumps:
                pump.cancel()
            if pumps:
                await asyncio.gather(*pumps, return_exceptions=True)
            if upstream:
                upstream.close()
            client.close()
            active -= 1

    server = await asyncio.start_server(
        handle, bind, port, family=socket.AF_INET, limit=HEADER_LIMIT, backlog=32
    )
    async with server:
        await server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--port", type=int, default=18087)
    parser.add_argument("--peer", required=True, type=ipaddress.IPv4Address)
    args = parser.parse_args()
    lan = ipaddress.IPv4Network("10.0.0.0/8")
    if args.bind not in lan or args.peer not in lan or not 1024 <= args.port <= 65535:
        parser.error("监听与来源须为私网 IPv4，端口须在 1024 至 65535 之间")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(serve(str(args.bind), args.port, str(args.peer)))


if __name__ == "__main__":
    main()
