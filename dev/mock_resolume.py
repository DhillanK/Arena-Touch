"""
Fake Resolume webserver for developing Arena Touch without Resolume running.

Serves a small made-up composition on 127.0.0.1:8080 in the same shape as Resolume's
real API: WebSocket /api/v1, GET /api/v1/composition and clip thumbnails. Clip triggers,
parameter changes, deck switching and playback positions all behave like the real thing.

    pip install websockets
    python3 dev/mock_resolume.py      # then, in another terminal:
    python3 server.py                  # and open http://localhost:8000
"""
import asyncio, json, itertools, zlib, struct, colorsys
import websockets
from websockets.http11 import Response
from websockets.datastructures import Headers

ids = itertools.count(1000)
P = {}
def prm(vt, value=None, **kw):
    p = {"id": next(ids), "valuetype": vt, **kw}
    if value is not None: p["value"] = value
    P[p["id"]] = p
    return p
def rng(v, lo=0, hi=1): return prm("ParamRange", v, min=lo, max=hi, **{"in": lo, "out": hi})
def choice(opts, v): return prm("ParamChoice", v, options=opts, index=opts.index(v))
STATE = ["Empty", "Disconnected", "Previewing", "Connected", "Connected & previewing"]
BLEND = ["Add", "Alpha", "Screen", "Multiply"]
NCOL, NLAY = 6, 4
DECKS = ["Main", "Abstract Loops", "Tunnels"]
deck_sel = 0
thumbs = {}

def png(color):
    w, h = 64, 40
    raw = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

def fx(name, bypass=True):
    return {"id": next(ids), "name": name, "display_name": name, "bypassed": prm("ParamBoolean", bypass),
            "params": {"Opacity": rng(1), "Frequency": rng(.5), "Fade": prm("ParamBoolean", False),
                       "Mode": choice(["Color", "Hue"], "Color"), "Color": prm("ParamColor", "#0000ffff"),
                       "MANUAL": prm("ParamEvent"), "Position X": rng(0, -32768, 32768)}}

def make_layers():
    layers = []
    for li in range(NLAY):
        clips = []
        for ci in range(NCOL):
            empty = (li + ci + deck_sel) % 5 == 4
            cid = next(ids)
            if not empty:
                r, g, b = colorsys.hsv_to_rgb(((li * NCOL + ci) * 0.07 + deck_sel * .3) % 1, .7, .9)
                thumbs[cid] = png((int(r * 255), int(g * 255), int(b * 255)))
            clips.append({"id": cid, "name": prm("ParamString", "" if empty else f"{DECKS[deck_sel]} clip {li+1}.{ci+1}"),
                          "connected": prm("ParamState", "Empty" if empty else "Disconnected", options=STATE),
                          "colorid": choice(["1","2","3","4","5","6"], str(1 + (li * 7 + ci * 3) % 6)),
                          "transport": {"position": rng(0, 0, 4000 + 1000 * ci)},
                          "thumbnail": {"id": cid, "is_default": empty, "last_update": "1", "path": ""}})
        layers.append({"id": 500 + li, "name": prm("ParamString", "Layer #" if li < 3 else "Content"),
                       "bypassed": prm("ParamBoolean", False), "solo": prm("ParamBoolean", False),
                       "colorid": choice(["1","2","3","4","5","6"], "6" if li == 3 else "1"),
                       "crossfadergroup": choice(["None", "A", "B"], "None"), "master": rng(1),
                       "video": {"opacity": rng(1), "mixer": {"Blend Mode": choice(BLEND, "Add")},
                                 "effects": [fx("Transform", None) | {"bypassed": None}, fx("Strobe")] if li == 0 else []},
                       "clips": clips})
    return layers

LAYERS = make_layers()
COMP = None
def build():
    global COMP
    COMP = {"name": prm("ParamString", "Demo Composition"), "master": rng(1),
            "video": {"effects": [fx("Colorize")]},
            "crossfader": {"id": 1, "phase": rng(0, -1, 1)},
            "decks": [{"id": 900 + i, "name": prm("ParamString", n), "selected": prm("ParamBoolean", i == deck_sel)} for i, n in enumerate(DECKS)],
            "layers": LAYERS,
            "columns": [{"id": 700 + i, "name": prm("ParamString", "Column #"), "connected": prm("ParamState", "Disconnected", options=["Empty", "Disconnected", "Connected"])} for i in range(NCOL)],
            "layergroups": [{"id": 600, "name": prm("ParamString", "Media + Effects"), "colorid": choice(["1","2","3","4","5","6"], "5"), "master": rng(1), "bypassed": prm("ParamBoolean", False),
                             "solo": prm("ParamBoolean", False), "crossfadergroup": choice(["None", "A", "B"], "None"),
                             "layers": [{"id": l["id"], "name": l["name"]} for l in LAYERS[:3]], "video": {"effects": []}}],
            "tempocontroller": {"play_state": choice(["Play","Pause","Stop"], "Play"), "tempo": rng(128.0, 20, 500), "tempo_tap": prm("ParamEvent"), "resync": prm("ParamEvent")}}
build()

clients = set(); subs = {}
LOG = []

async def upd(p):
    msg = json.dumps({**p, "type": "parameter_update"})
    for ws in list(clients):
        if p["id"] in subs.get(ws, ()):
            await ws.send(msg)

async def connect_clip(clip_id):
    for l in LAYERS:
        for c in l["clips"]:
            if c["id"] == clip_id and c["connected"]["value"] != "Empty":
                for o in l["clips"]:
                    if o["connected"]["value"] == "Connected":
                        o["connected"]["value"] = "Disconnected"; await upd(o["connected"])
                c["connected"]["value"] = "Connected"; await upd(c["connected"])

async def handler(ws):
    global deck_sel, LAYERS
    clients.add(ws); subs[ws] = set()
    await ws.send(json.dumps(COMP))
    await ws.send(json.dumps({"type": "sources_update", "value": {}}))
    try:
        async for raw in ws:
            m = json.loads(raw); LOG.append(m)
            path = m.get("parameter", "")
            if m["action"] in ("subscribe", "get"):
                pid = int(path.rsplit("/", 1)[1]); subs[ws].add(pid) if m["action"] == "subscribe" else None
                await ws.send(json.dumps({**P[pid], "type": "parameter_subscribed"}))
            elif m["action"] == "unsubscribe":
                subs[ws].discard(int(path.rsplit("/", 1)[1]))
            elif m["action"] == "set":
                p = P[int(path.rsplit("/", 1)[1])]
                v = m["value"]
                if "options" in p and isinstance(v, int): p["index"] = v; v = p["options"][v]
                p["value"] = v; await upd(p)
            elif m["action"] == "trigger":
                parts = path.strip("/").split("/")
                if parts[1] == "clips" and parts[-1] == "connect" and m.get("value") is True:
                    await connect_clip(int(parts[3]))
                elif parts[1] == "columns" and parts[-1] == "connect" and m.get("value") is True:
                    ci = int(parts[3]) - 700
                    for l in LAYERS: await connect_clip(l["clips"][ci]["id"])
                elif parts[1] == "layers" and parts[-1] == "clear":
                    for l in LAYERS:
                        if l["id"] == int(parts[3]):
                            for c in l["clips"]:
                                if c["connected"]["value"] == "Connected": c["connected"]["value"] = "Disconnected"; await upd(c["connected"])
                elif parts[1] == "decks" and parts[-1] == "select":
                    deck_sel = int(parts[3]) - 900; LAYERS = make_layers(); build()
                    for c in list(clients): await c.send(json.dumps(COMP))
    finally:
        clients.discard(ws); subs.pop(ws, None)

def http(conn, req):
    if req.path == "/api/v1":
        return None
    if req.path == "/api/v1/composition":
        return Response(200, "OK", Headers({"Content-Type": "application/json"}), json.dumps(COMP).encode())
    if req.path == "/_log":
        return Response(200, "OK", Headers({"Content-Type": "application/json"}), json.dumps(LOG[-200:]).encode())
    if "/thumbnail" in req.path:
        cid = int(req.path.split("/")[6])
        return Response(200, "OK", Headers({"Content-Type": "image/png"}), thumbs.get(cid, png((40, 40, 40))))
    return Response(404, "Not Found", Headers(), b"nf")

async def ticker():
    while True:
        await asyncio.sleep(1/30)
        for l in LAYERS:
            for c in l["clips"]:
                if c["connected"]["value"] == "Connected":
                    p = c["transport"]["position"]; p["value"] = (p["value"] + 33) % p["max"]; await upd(p)

async def main():
    asyncio.create_task(ticker())
    async with websockets.serve(handler, "127.0.0.1", 8080, process_request=http):
        await asyncio.Future()
asyncio.run(main())
