import sys, json
for line in sys.stdin:
    try:
        j = json.loads(line)
    except Exception:
        continue
    m = j.get('message') or {}
    if m.get('role') == 'assistant' and m.get('stopReason') == 'error':
        print('PPTERR ' + (m.get('errorMessage') or '')[:300].replace('\n', ' '), flush=True)
    elif j.get('type') == 'custom' and (j.get('data') or {}).get('stopReason') == 'provider-error':
        print('PPTERR provider-error (cache-keepalive)', flush=True)
