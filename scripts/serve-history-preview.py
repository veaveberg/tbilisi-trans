"""Serve the built preview with live repository data, without rebuilding assets."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

PUBLIC = Path(__file__).resolve().parents[1] / 'public'


class LiveDataHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        requested = unquote(urlsplit(path).path)
        live = requested.startswith('/data/') or (requested.startswith('/data-history/') and requested.endswith('.json'))
        if live:
            target = (PUBLIC / requested.lstrip('/')).resolve()
            if target.is_relative_to(PUBLIC.resolve()):
                return str(target)
            return str(PUBLIC / '__invalid_path__')
        return super().translate_path(path)

    def end_headers(self):
        if urlsplit(self.path).path.endswith('.json'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default='/tmp/ttc-history-map-preview')
    parser.add_argument('--port', type=int, default=5187)
    args = parser.parse_args()
    handler = partial(LiveDataHandler, directory=args.directory)
    print(f'Preview: http://127.0.0.1:{args.port}/data-history/ (live data from {PUBLIC})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), handler).serve_forever()
