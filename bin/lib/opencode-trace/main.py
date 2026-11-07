"""Run an isolated OpenCode free-model call through a process-local MITM proxy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Explicit OpenCode model, e.g. opencode/big-pickle")
    parser.add_argument("--cli", default="opencode")
    parser.add_argument("--private-wire", action="store_true", help="Save exact bodies locally, never auth headers")
    parser.add_argument("--account", help="Explicit saved OpenCode account label to copy into the isolated run")
    parser.add_argument("--login-probe", action="store_true", help="Capture device-code initiation and pending polls; no browser approval")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    if not args.model.startswith("opencode/"):
        parser.error("select the opencode provider explicitly")
    cli = shutil.which(args.cli)
    if not cli or not shutil.which("uv"):
        parser.error("requires opencode and uv on PATH")
    os.umask(0o077)
    root = Path("tmp/opencode-http/runs") / datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S.%fZ")
    root = root.resolve()
    for name in ("workspace", "config", "data", "state", "cache"):
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    # Pass no account credentials, provider keys, hooks, project config or global plugin settings.
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "HOME", "LANG", "TERM", "TMPDIR"}}
    env.update({"XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
        "XDG_STATE_HOME": str(root / "state"), "XDG_CACHE_HOME": str(root / "cache"),
        "OPENCODE_CONFIG_DIR": str(root / "config"), "OPENCODE_DISABLE_AUTOUPDATE": "1",
        "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_DISABLE_CLAUDE_CODE": "1",
        "OPENCODE_CONFIG_CONTENT": json.dumps({"permission": {"*": "deny"}, "plugin": []}),
        "NO_PROXY": "localhost,127.0.0.1", "no_proxy": "localhost,127.0.0.1"})
    version = subprocess.check_output([cli, "--version"], env=env, text=True).strip()
    with open(cli, "rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    manifest = {"cliVersion": version, "cliSha256": digest, "model": args.model,
        "proxyVersion": "12.2.3", "privateWire": args.private_wire,
        "isolated": True, "authenticated": args.account is not None,
        "startedAt": datetime.now(timezone.utc).isoformat()}
    if args.account:
        # Secret material stays in the pipe and the isolated client's own credential store.
        exported = subprocess.check_output([cli, "auth", "export", "opencode", "--standalone"],
                                          cwd=root / "workspace", text=True)
        selected = [row for row in json.loads(exported) if row.get("label") == args.account]
        if len(selected) != 1 or selected[0].get("value", {}).get("type") != "oauth":
            parser.error("--account must name exactly one saved OpenCode OAuth account")
        if selected[0]["value"]["expires"] < time.time() * 1000 + 300000:
            parser.error("refresh the selected account in OpenCode before capturing; no cloned refresh")
        subprocess.run([cli, "auth", "import", "--standalone"], input=json.dumps(selected),
                       env=env, cwd=root / "workspace", text=True, check=True, capture_output=True)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proxy_env = {**env, "OPENCODE_TRACE_DIR": str(root),
                 "OPENCODE_TRACE_PRIVATE": "1" if args.private_wire else "0"}
    print(f"Trace artifacts: {root}", flush=True)
    with (root / "proxy.log").open("w") as log:
        proxy = subprocess.Popen(["uv", "tool", "run", "--from", "mitmproxy==12.2.3", "mitmdump",
            "--listen-host", "127.0.0.1", "--listen-port", str(port),
            "--set", f"confdir={root / 'ca'}", "--set", "flow_detail=0",
            "--set", "termlog_verbosity=error", "-s", str(Path(__file__).with_name("capture.py").resolve())],
            env=proxy_env, stdout=log, stderr=log, start_new_session=True)
        child = None
        try:
            cert = root / "ca/mitmproxy-ca-cert.pem"
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if proxy.poll() is not None:
                    raise RuntimeError("proxy exited; inspect proxy.log")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        if cert.exists():
                            break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("proxy did not start")
            url = f"http://127.0.0.1:{port}"
            env.update({"HTTPS_PROXY": url, "HTTP_PROXY": url, "https_proxy": url, "http_proxy": url,
                        "NODE_EXTRA_CA_CERTS": str(cert), "SSL_CERT_FILE": str(cert)})
            with (root / "cli.jsonl").open("w") as stdout, (root / "cli.log").open("w") as stderr:
                command = [cli, "run", "--standalone", "--model", args.model,
                    "--format", "json", "--title", "Synthetic wire trace",
                    "Reply with exactly TRACE_42. Do not call any tools."]
                if args.login_probe:
                    command = [cli, "auth", "login", "opencode", "--method", "device", "--standalone"]
                child = subprocess.Popen(command,
                    cwd=root / "workspace", env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                try:
                    manifest["exitCode"] = child.wait(timeout=15 if args.login_probe else args.timeout)
                except subprocess.TimeoutExpired:
                    if not args.login_probe:
                        raise
                    manifest["loginProbeStoppedBeforeApproval"] = True
            time.sleep(0.2)
        finally:
            for process in (child, proxy):
                if process and process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
            (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    flows = root / "flows.jsonl"
    records = [json.loads(line) for line in flows.read_text().splitlines()] if flows.exists() else []
    for record in records:
        print(json.dumps({"method": record["method"], "path": record["path"],
            "model": (record.get("body") or {}).get("model"), "status": record.get("status"),
            "headers": record["headers"], "done": record.get("done")}))
    if args.login_probe and any(r.get("status") == 200 and r["path"].endswith("/device/code") for r in records):
        return
    if manifest.get("exitCode") != 0 or not any(r.get("status") == 200 and r["method"] == "POST" for r in records):
        raise SystemExit("No successful inference captured; inspect local artifacts")


if __name__ == "__main__":
    main()
