#!/usr/bin/env python3
"""Refresh city data and publish a validated snapshot from an isolated checkout."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from datetime import datetime

STATE = Path(os.environ.get('TTC_UPDATER_STATE', str(Path.home() / '.local/share/ttc-updater')))
REPO = STATE / 'repo'
ENV = {**os.environ, 'PATH': str(STATE / 'runtime/node/bin') + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'TZ': 'Asia/Tbilisi', 'TRANSIT_PREFETCH_CONCURRENCY': '3', 'TRANSIT_PREFETCH_STRICT': '1', 'GIT_SSH_COMMAND': str(STATE / 'ssh-git.sh'), 'GIT_TERMINAL_PROMPT': '0', 'CI': '1'}


def run(args, cwd=REPO, capture=False):
    print('+', ' '.join(map(str, args)), flush=True)
    process = subprocess.Popen(list(map(str, args)), cwd=cwd, env=ENV, text=True, stdout=subprocess.PIPE if capture else None, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=4 * 60 * 60)
    except BaseException:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait()
        raise
    if process.returncode:
        raise RuntimeError(f'{args[0]} exited with {process.returncode}')
    return output.strip() if capture else None


def read(path):
    return json.loads(path.read_text())


def validate(before, current):
    for city in ['tbilisi', 'rustavi', 'kutaisi', 'batumi']:
        for locale in ['en', 'ka']:
            for kind in ['stops', 'routes']:
                name = f'{city}_{kind}_{locale}.json'
                old, new = read(before / name), read(current / name)
                if not isinstance(new, list) or not new or len(new) < len(old) * .8:
                    raise RuntimeError(f'{name}: empty or unexpectedly reduced dataset')
            old_details = read(before / f'{city}_routes_details_{locale}.json')
            new_details = read(current / f'{city}_routes_details_{locale}.json')
            routes = read(current / f'{city}_routes_{locale}.json')
            for route in routes:
                identity = str(route['id'])
                if identity in old_details and identity not in new_details:
                    raise RuntimeError(f'{city}: missing route details for {identity}')
                if old_details.get(identity, {}).get('_stopsOfPatterns') and not new_details.get(identity, {}).get('_stopsOfPatterns'):
                    raise RuntimeError(f'{city}: missing stop patterns for {identity}')
        for kind in ['schedules', 'polylines']:
            old, new = read(before / f'{city}_{kind}.json'), read(current / f'{city}_{kind}.json')
            if not isinstance(new, dict) or old and len(new) < len(old) * .8:
                raise RuntimeError(f'{city}: unexpectedly incomplete {kind}')
    print('All city datasets passed completeness checks.', flush=True)


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'refresh.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('A refresh is already running; skipping.', flush=True)
            return
        run(['node', '--version'])
        run(['git', 'fetch', 'origin', 'main'])
        run(['git', 'merge', '--ff-only', 'origin/main'])
        if '--check' in sys.argv:
            run(['git', 'push', '--dry-run', 'origin', 'origin/main:refs/heads/main'])
            print('Runtime, GitHub read/write access, and scheduler prerequisites verified.', flush=True)
            return
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        checkout = STATE / 'runs' / stamp
        checkout.parent.mkdir(exist_ok=True)
        run(['git', 'worktree', 'add', '--detach', checkout, 'origin/main'])
        seed = STATE / 'seed/public'
        if seed.exists() and not (STATE / 'seed-published').exists():
            for folder in ['data', 'data-history']:
                shutil.copytree(seed / folder, checkout / 'public' / folder, dirs_exist_ok=True)
        archive = STATE / 'archive'
        if archive.exists():
            shutil.copytree(archive, checkout / 'data-archive', dirs_exist_ok=True)
        before = checkout / '.refresh-baseline'
        shutil.copytree(checkout / 'public/data', before)
        run(['npm', 'ci', '--no-audit', '--no-fund'], checkout)
        run(['npm', 'run', 'data:update'], checkout)
        validate(before, checkout / 'public/data')
        run(['npm', 'run', 'test:data-history'], checkout)
        run(['npm', 'run', 'test:prefetch-concurrency'], checkout)
        # Every output path is explicit; runtime files and credentials never enter Git.
        run(['git', 'add', 'public/data', 'public/data-history', 'ota/files', 'ota/manifest.json'], checkout)
        changes = run(['git', 'diff', '--cached', '--name-only'], checkout, capture=True).splitlines()
        ignored = {'public/data/manifest.json', 'ota/manifest.json', 'public/data-history/index.json'}
        old_index = run(['git', 'show', 'HEAD:public/data-history/index.json'], checkout, capture=True)
        same_history = read(checkout / 'public/data-history/index.json')['entries'] == json.loads(old_index)['entries']
        meaningful = any(name not in ignored for name in changes) or not same_history
        if meaningful:
            run(['git', '-c', 'user.name=Transit data updater', '-c', 'user.email=transit-updater@users.noreply.github.com', 'commit', '-m', f'Refresh transit data and service history ({stamp})'], checkout)
            # Concurrent website edits never get overwritten. A rejected push leaves
            # this complete checkout for inspection; the next run starts from main.
            run(['git', 'push', 'origin', 'HEAD:main'], checkout)
        else:
            print('No data or service changes; no publication needed.', flush=True)
        old_archive = STATE / 'archive-previous'
        if old_archive.exists(): shutil.rmtree(old_archive)
        if archive.exists(): archive.rename(old_archive)
        shutil.move(str(checkout / 'data-archive'), str(archive))
        (STATE / 'seed-published').touch()
        (STATE / 'last-success.json').write_text(json.dumps({'completedAt': datetime.now().astimezone().isoformat(), 'published': meaningful, 'commit': run(['git', 'rev-parse', 'HEAD'], checkout, capture=True)}) + '\n')
        shutil.rmtree(before)
        run(['git', 'worktree', 'remove', '--force', checkout])
        print('Daily refresh complete.', flush=True)


if __name__ == '__main__':
    main()
