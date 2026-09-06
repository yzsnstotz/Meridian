#!/usr/bin/env python3
"""Read-only recovery of one native App handoff. Never edits Codex state or transcripts."""
import argparse
import datetime as dt
import json
from pathlib import Path
import sqlite3


def inspect_rollout(filename, marker):
    turns = []
    current = None
    for line in Path(filename).read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue  # only an unfinished tail may be absent from this snapshot
        payload = row.get('payload', {})
        if row.get('type') == 'event_msg' and payload.get('type') == 'task_started':
            current = {'turnId': payload['turn_id'], 'status': 'running', 'matched': False}
            turns.append(current)
        if not current:
            continue
        if row.get('type') == 'response_item':
            is_input = payload.get('role') == 'user' or (
                payload.get('type') == 'function_call_output' and payload.get('namespace') == 'codex_app'
                and payload.get('name') in {'create_thread', 'send_message_to_thread'})
            if is_input and marker in json.dumps(payload, ensure_ascii=False):
                current['matched'] = True
            if payload.get('role') == 'assistant' and payload.get('phase') == 'commentary':
                text = '\n'.join(c.get('text', '') for c in payload.get('content', []) if isinstance(c, dict))
                if text:
                    current['progress'] = text
        if row.get('type') == 'event_msg' and payload.get('turn_id') == current['turnId']:
            kind = payload.get('type')
            if kind == 'task_complete':
                current.update(status='completed', text=payload.get('last_agent_message', ''))
            elif kind == 'turn_aborted':
                current.update(status='interrupted', text='Codex recorded this exact App turn as aborted.')
    return [{k: v for k, v in turn.items() if k != 'matched'} for turn in turns if turn['matched']]


def observe(request, state_db):
    marker = '[Meridian App handoff request: ' + request['id'] + ']'
    with sqlite3.connect(Path(state_db).resolve().as_uri() + '?mode=ro', uri=True) as db:
        if request.get('threadId'):
            rows = db.execute('SELECT id,rollout_path FROM threads WHERE id=?', (request['threadId'],)).fetchall()
        else:
            after = int(dt.datetime.fromisoformat(request['createdAt'].replace('Z', '+00:00')).timestamp()) - 5
            rows = db.execute("SELECT id,rollout_path FROM threads WHERE created_at>=? AND source='vscode' ORDER BY created_at DESC LIMIT 101", (after,)).fetchall()
            if len(rows) > 100:
                raise RuntimeError('Recovery candidates exceed bound; use the native App creation receipt, never create a duplicate')
    matches = []
    for thread_id, rollout_path in rows:
        for turn in inspect_rollout(rollout_path, marker):
            matches.append({'threadId': thread_id, **turn})
    if len(matches) != 1:
        raise RuntimeError(f'Expected one exact request-marked App turn, found {len(matches)}; keep claimed and reconcile without resending')
    result = matches[0]
    if request.get('turnId') and request['turnId'] != result['turnId']:
        raise RuntimeError('Native turn conflicts with recorded turn; no mutation performed')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request-file', required=True)
    parser.add_argument('--state-db', default=str(Path.home() / '.codex/state_5.sqlite'))
    parser.add_argument('--output')
    args = parser.parse_args()
    try:
        observation = observe(json.loads(Path(args.request_file).read_text()), args.state_db)
        encoded = json.dumps(observation, ensure_ascii=False) + '\n'
        if args.output:
            import os
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write(encoded)
        print(encoded, end='')
    except Exception as error:
        parser.exit(1, str(error) + '\n')
