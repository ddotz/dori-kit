#!/usr/bin/env python3
"""Back up the assistant harness config + every memory repo to ONE private GitHub repo.

  main              -> config/<home-relative path> snapshot (allowlist, secrets-scanned)
  memory/<agentdir> -> full history of ~/.omo/memory/agents/<agentdir>/repo

usage: backup.py [--owner OWNER (default: config.json github_owner)] [--layer-dir DIR] [--repo NAME (default: config.json backup_repo)] [--dry-run]
Token: $BACKUP_TOKEN, else `gh auth token`, else macOS keychain item gh:github.com.
Never copies auth.json, credential pools, sessions, logs, inbox/mail data.
"""
import argparse, base64, json, os, re, shutil, subprocess, sys, urllib.request, urllib.error

HOME = os.path.expanduser("~")
LAYER_DIR = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(LAYER_DIR, "config.json")))
LAYER = CFG.get("layer") or os.path.basename(LAYER_DIR).lstrip(".")
REPO = CFG.get("backup_repo") or LAYER + "-backup"
WORK = os.path.join(HOME, "." + REPO)
SECRET = re.compile(
    r"gh[pousr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}"
    r"|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{30,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----|[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}"
    r"|(?i:\"?(?:api_?key|access_?token|refresh_?token|client_?secret|password|passwd)\"?\s*[:=]\s*\"?[A-Za-z0-9._~+/=-]{16,})"
)
SKIP_WALK = {"Library", ".Trash", "node_modules", ".git", "Applications", "Movies", "Music", "Pictures", ".omo", ".senpi", ".cache", ".bun", ".npm", ".claude"}
MAX_BYTES = 1_000_000
SECRET_DIRS = {"secrets", ".secrets", "credentials"}
SECRET_NAME = re.compile(r"(?i)^(auth|credential|\.env)|\.(pem|key|p12)$")
SECRET_KEY = re.compile(r"(?i)(pass|pw$|secret|token|key|credential|cookie|auth)")


def json_secret(txt):
    try:
        data = json.loads(txt)
    except ValueError:
        return False
    stack = [data]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str) and SECRET_KEY.search(k) and len(v) >= 6 and not v.startswith(("!", "$")):
                    return True
                stack.append(v)
        elif isinstance(o, list):
            stack.extend(o)
    return False


def log(msg):
    print(msg, flush=True)


def token():
    t = os.environ.get("BACKUP_TOKEN", "").strip()
    if t:
        return t
    if shutil.which("gh"):
        r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    r = subprocess.run(["security", "find-generic-password", "-s", "gh:github.com", "-w"], capture_output=True, text=True)
    v = r.stdout.strip()
    if r.returncode == 0 and v:
        if v.startswith("go-keyring-base64:"):
            v = base64.b64decode(v.split(":", 1)[1]).decode()
        return v
    sys.exit("no GitHub token available (gh auth token / keychain gh:github.com both failed; keychain needs the GUI session)")


def api(method, path, tok, body=None):
    req = urllib.request.Request("https://api.github.com" + path, method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def git(args, cwd, tok=None, check=True):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    if tok:
        hdr = "AUTHORIZATION: basic " + base64.b64encode(("x-access-token:" + tok).encode()).decode()
        env.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0=hdr)
    r = subprocess.run(["git"] + args, cwd=cwd, env=env, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError("git %s failed: %s" % (args[0], r.stderr.strip()[-300:].replace(tok or "\0", "***")))
    return r


def candidates(omodir):
    files = []
    def add(p):
        if os.path.isfile(p) and os.path.getsize(p) <= MAX_BYTES:
            files.append(p)
    for p in ("~/.omo/omo.jsonc", "~/.omo/agent/settings.json", "~/.omo/agent/models.json", "~/.omo/agent/trust.json", "~/.claude/CLAUDE.md"):
        add(os.path.expanduser(p))
    if os.path.isdir(os.path.join(HOME, "Library/LaunchAgents")):
        d = os.path.join(HOME, "Library/LaunchAgents")
        for n in os.listdir(d):
            if n.startswith("dev.%s." % LAYER) and ".bak" not in n:
                add(os.path.join(d, n))
    # layer dir: code, runbooks, state.json; never inbox/logs/attachments/out/.state
    for root, dirs, names in os.walk(omodir):
        dirs[:] = [x for x in dirs if x not in {"logs", "attachments", "out", ".state", "generated-images", "node_modules", "__pycache__", ".git", "PPT", "놀이활동", "추가활동", "senpi-task", "thread-tools", "evidence"} | SECRET_DIRS]
        depth = root[len(omodir):].count(os.sep)
        if depth > 2:
            dirs[:] = []
        for n in names:
            if ".bak" in n or ".app/" in os.path.join(root, n) or SECRET_NAME.search(n) or n.endswith((".log", ".jsonl", ".err")) or n.endswith(("-state.json", "-watch.json", "-threads.json")) or n in {"token-audit.json", "hooks-state.json"}:
                continue
            if n.endswith((".ts", ".md", ".sh", ".py", ".json", ".jsonc", ".plist", ".swift")) or n == "state.json":
                add(os.path.join(root, n))
    # project-level .omo/.senpi settings + instruction files, depth <= 3 under HOME
    for root, dirs, names in os.walk(HOME):
        depth = root[len(HOME):].count(os.sep)
        if depth >= 3:
            dirs[:] = []
        for sub in (".omo", ".senpi"):
            if sub in dirs:
                sd = os.path.join(root, sub)
                for n in os.listdir(sd):
                    if ".bak" not in n and n.endswith((".json", ".jsonc", ".md")):
                        add(os.path.join(sd, n))
        for n in ("AGENTS.md", "CLAUDE.md"):
            if depth >= 1 and n in names and (".omo" in dirs or ".senpi" in dirs):
                add(os.path.join(root, n))
        dirs[:] = [x for x in dirs if x not in SKIP_WALK and not x.startswith(".")]
    return sorted(set(files))


def snapshot_config(omodir, dest):
    shutil.rmtree(os.path.join(dest, "config"), ignore_errors=True)
    kept, skipped = 0, []
    for src in candidates(omodir):
        try:
            txt = open(src, encoding="utf8").read()
        except (UnicodeDecodeError, OSError):
            skipped.append((src, "unreadable"))
            continue
        if SECRET.search(txt) or json_secret(txt):
            skipped.append((src, "secret-pattern"))
            continue
        rel = os.path.relpath(src, HOME)
        out = os.path.join(dest, "config", rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(src, out)
        kept += 1
    return kept, skipped


def history_has_secret(repo, since):
    rng = [since + "..HEAD"] if since else ["HEAD"]
    p = subprocess.Popen(["git", "-C", repo, "log", "-p"] + rng, stdout=subprocess.PIPE)
    hit = False
    for line in p.stdout:
        if SECRET.search(line.decode("utf8", "ignore")):
            hit = True
            break
    p.stdout.close(); p.kill(); p.wait()
    return hit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default=CFG["github_owner"])
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--layer-dir", "--omonyang-dir", dest="layer_dir", default=LAYER_DIR)  # promote:allow (legacy flag kept for existing plists)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    omodir = os.path.expanduser(a.layer_dir)
    os.makedirs(WORK, exist_ok=True)
    work = os.path.join(WORK, "config-repo")
    pushed_path = os.path.join(WORK, "pushed.json")
    pushed = json.load(open(pushed_path)) if os.path.exists(pushed_path) else {}

    if not os.path.isdir(os.path.join(work, ".git")):
        os.makedirs(work, exist_ok=True)
        git(["init", "-q", "-b", "main"], work)
        git(["config", "user.name", a.repo], work)
        git(["config", "user.email", a.repo + "@localhost"], work)
    kept, skipped = snapshot_config(omodir, work)
    log("config: %d files copied, %d skipped %s" % (kept, len(skipped), [(os.path.relpath(s, HOME), w) for s, w in skipped]))
    git(["add", "-A"], work)
    changed = bool(git(["status", "--porcelain"], work).stdout.strip())
    if changed and not a.dry_run:
        git(["commit", "-q", "-m", "config snapshot"], work)

    mems = []
    for d in sorted(os.listdir(os.path.join(HOME, ".omo/memory/agents"))):
        repo = os.path.join(HOME, ".omo/memory/agents", d, "repo")
        if os.path.isdir(os.path.join(repo, ".git")):
            head = git(["rev-parse", "HEAD"], repo).stdout.strip()
            mems.append((d, repo, head))
    log("memory repos: %d (%d need push)" % (len(mems), sum(1 for d, _, h in mems if pushed.get(d) != h)))
    if a.dry_run:
        for d, repo, head in mems:
            if pushed.get(d) != head and history_has_secret(repo, pushed.get(d)):
                log("  SECRET in history, would skip: " + d)
        return

    tok = token()
    url = "https://github.com/%s/%s.git" % (a.owner, a.repo)
    code, info = api("GET", "/repos/%s/%s" % (a.owner, a.repo), tok)
    if code == 404:
        code, info = api("POST", "/user/repos", tok, {"name": a.repo, "private": True, "description": "%s harness + memory backup" % LAYER})
        if code != 201:
            sys.exit("repo create failed: %s %s" % (code, info.get("message")))
        log("created private repo %s/%s" % (a.owner, a.repo))
    elif code != 200:
        sys.exit("repo check failed: %s %s" % (code, info.get("message")))
    if not info.get("private"):
        sys.exit("refusing to push: %s/%s is not private" % (a.owner, a.repo))

    git(["push", url, "HEAD:refs/heads/main"], work, tok)
    log("pushed main")
    for d, repo, head in mems:
        if pushed.get(d) == head:
            continue
        if history_has_secret(repo, pushed.get(d)):
            log("  SKIP %s: secret-like string in history" % d)
            continue
        try:
            git(["push", url, "HEAD:refs/heads/memory/" + d], repo, tok)
            pushed[d] = head
            log("  pushed memory/" + d)
        except RuntimeError as e:
            log("  FAIL %s: %s" % (d, e))
    json.dump(pushed, open(pushed_path, "w"))


if __name__ == "__main__":
    main()
