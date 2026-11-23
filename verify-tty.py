"""Offline Pi 1.6 regression tests, using the rendered PTY screen rather than scrollback."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time

import pyte

PI = str(Path(sys.argv[1]).resolve())
EXTENSION = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).parent / "extensions/setmodel.ts"
MODELS = {"providers": {"lab": {
    "baseUrl": "http://127.0.0.1:1/v1", "api": "openai-completions", "apiKey": "test-only",
    "models": [
        {"id": "test-reasoner", "reasoning": True, "thinkingLevelMap": {
            "minimal": None, "low": None, "medium": None, "high": "high", "xhigh": None, "max": "max"
        }},
        {"id": "test-plain", "reasoning": False},
    ],
}}}


class Terminal:
    def __init__(self, root, mode, width, extra=()):
        self.settings = root / "agent/settings.json"
        self.height, self.width = 36, width
        self.screen = pyte.Screen(width, self.height)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            self.resize(0)
            os.chdir(root / "project")
            env = {"HOME": str(root), "PI_CODING_AGENT_DIR": str(root / "agent"),
                   "PATH": os.environ["PATH"], "TERM": "xterm-256color", "LANG": "C.UTF-8"}
            os.execve(PI, [PI, "--offline", "--no-session", "--no-extensions", "--no-approve",
                           "--tui-mode", mode, *extra, "-e", str(EXTENSION)], env)
        self.resize(self.fd)

    def resize(self, fd):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.height, self.width, 0, 0))

    def pump(self, timeout):
        if select.select([self.fd], [], [], timeout)[0]:
            try:
                data = os.read(self.fd, 65536)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                raise AssertionError("Pi exited unexpectedly:\n" + self.frame())
            self.stream.feed(data)

    def frame(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def wait(self, predicate, name):
        deadline = time.monotonic() + 5
        while not predicate():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"{name}:\n{self.frame()}")
            self.pump(remaining)

    def settle(self):
        deadline = time.monotonic() + 0.12
        while time.monotonic() < deadline:
            self.pump(max(0, deadline - time.monotonic()))

    def send(self, data):
        os.write(self.fd, data.encode())

    def paste(self, text):
        self.send(f"\x1b[200~{text}\x1b[201~")

    def defaults(self):
        data = json.loads(self.settings.read_text()) if self.settings.exists() else {}
        return {key: data.get(key) for key in ("defaultProvider", "defaultModel", "defaultThinkingLevel")}

    def input_is(self, text):
        return any(line.strip() == text for line in self.screen.display)

    def row(self, label):
        pattern = re.compile(r"^\s*(?:[→›❯>]\s*)?" + re.escape(label) + r"(?:\s|$)")
        return next((row for row, line in enumerate(self.screen.display, 1) if pattern.match(line)), None)

    def click(self, label):
        row = self.row(label)
        assert row, self.frame()
        self.send(f"\x1b[<0;5;{row}M\x1b[<0;5;{row}m")

    def reset_input(self, text):
        self.send("\x1b")
        self.settle()
        self.send("\x05")  # end of line
        self.settle()
        self.send("\x15")  # delete to line start
        self.wait(lambda: not self.input_is(text), "clear input")

    def close(self):
        os.close(self.fd)
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(self.pid, 0)


def run(mode, width):
    with tempfile.TemporaryDirectory(prefix="setmodel-tty-") as work:
        root = Path(work)
        (root / "agent").mkdir()
        (root / "project").mkdir()
        (root / "project/fixture-file.txt").touch()
        (root / "agent/models.json").write_text(json.dumps(MODELS))
        t = Terminal(root, mode, width)
        try:
            t.wait(lambda: "[Extensions]" in t.frame() and "test-reasoner" in t.frame(), "startup")
            t.send("/")
            t.wait(lambda: t.input_is("/"), "slash")
            for char in "setmo":
                t.send(char)
                t.pump(0.15)
            t.wait(lambda: t.row("/setmodel") or t.row("setmodel"), "native command menu")
            t.send("\t")
            t.wait(lambda: t.input_is("/setmodel") and t.row("test-plain") and t.row("test-reasoner"), "command → models")
            if mode == "fullscreen":
                t.click("test-reasoner")
            else:
                t.send("\r")
            base = "/setmodel lab/test-reasoner"
            t.wait(lambda: t.input_is(base) and t.row("off") and t.row("max"), "model → thinking levels")
            assert not t.row("medium"), t.frame()
            assert t.defaults()["defaultThinkingLevel"] != "max", "accepting a model submitted the command"
            t.send("m")
            t.wait(lambda: t.input_is(base + " m") and t.row("max") and not t.row("high"), "filter level")
            t.send("\r")
            t.wait(lambda: t.input_is(base + " max") and not t.row("max"), "accept level, do not submit")
            assert t.defaults()["defaultThinkingLevel"] != "max", "accepting a level submitted the command"
            t.send("\r")
            saved = "thinking: max (saved as default)"
            t.wait(lambda: saved in t.frame(), "explicit submission")
            assert t.frame().count(saved) == 1, t.frame()
            assert json.loads(t.settings.read_text())["defaultThinkingLevel"] == "max"

            t.paste("/setmodel    lab/test-plain")
            plain = "/setmodel    lab/test-plain"
            t.wait(lambda: t.input_is(plain) and not t.row("off"), "exact model without level")
            t.send(" ")
            t.wait(lambda: t.input_is(plain) and t.row("off"), "space shows even a single level instead of inserting it")
            t.send("\x1b")
            t.wait(lambda: not t.row("off"), "Escape closes menu")
            t.send("\t")
            complete = "/setmodel lab/test-plain off"
            t.wait(lambda: t.input_is(complete) and not t.row("off"), "explicit Tab inserts unique terminal candidate")
            t.send("\x1b[D")
            t.settle()
            t.send("\t")
            t.settle()
            assert t.input_is(complete) and not t.row("off"), t.frame()
            t.reset_input(complete)

            t.paste(base + " zz")
            t.wait(lambda: t.input_is(base + " zz") and not t.row("max"), "pasted invalid prefix")
            t.send("\x7f\x7f")
            t.wait(lambda: t.input_is(base) and t.row("max"), "deletion restores menu")
            t.reset_input(base)
            t.paste('/setmodel "lab/test-reasoner" ')
            quoted = '/setmodel "lab/test-reasoner"'
            t.wait(lambda: t.input_is(quoted) and not t.row("max"), "quoted model is not a valid reference")
            t.reset_input(quoted)

            t.send("/setmodel zzzz")
            t.wait(lambda: t.input_is("/setmodel zzzz") and not t.row("test-reasoner"), "unmatched model prefix")
            t.reset_input("/setmodel zzzz")
            t.paste("/setmodel reas")
            t.wait(lambda: t.row("test-reasoner"), "partial model")
            t.send("\x1b")
            t.wait(lambda: not t.row("test-reasoner"), "close model menu")
            t.send("\t")
            t.wait(lambda: t.input_is(base) and t.row("max"), "forced unique model still opens the next menu")
            t.reset_input(base)

            t.send("./fixture-f\t")
            t.wait(lambda: t.input_is("./fixture-file.txt"), "native path completion")
            t.reset_input("./fixture-file.txt")
            t.send("@fixture")
            t.wait(lambda: t.row("fixture-file.txt"), "native attachment menu")
            t.reset_input("@fixture")
            t.send("/chan")
            t.wait(lambda: t.row("changelog"), "native unrelated command menu")
            t.reset_input("/chan")
            t.paste("/reload")
            t.wait(lambda: t.input_is("/reload"), "reload ready")
            t.send("\r")
            t.wait(lambda: "Reloaded" in t.frame(), "reload completed")
            t.paste(base + " ")
            t.wait(lambda: t.input_is(base) and t.row("max"), "cascade works after reload")
            t.reset_input(base)
            t.send("/setmo")
            t.wait(lambda: t.row("setmodel"), "command name menu before Enter")
            t.send("\r")
            t.wait(lambda: "Usage: /setmodel" in t.frame(), "command-name Enter submits bare command")
            assert not t.row("test-plain"), t.frame()
        finally:
            t.close()
    print(f"PASS {mode} ({width} columns)")


def run_composition():
    with tempfile.TemporaryDirectory(prefix="setmodel-composition-") as work:
        root = Path(work)
        (root / "agent").mkdir()
        (root / "project").mkdir()
        (root / "agent/models.json").write_text(json.dumps(MODELS))
        (root / "agent/keybindings.json").write_text(json.dumps({"tui.input.tab": "f2"}))
        started = root / "project/started"
        fixture = root / "fixture.ts"
        fixture.write_text('''import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.registerCommand("setmodel", { handler: async () => {} });
  pi.registerCommand("slow", {
    async getArgumentCompletions() {
      writeFileSync("started", "1");
      await new Promise((resolve) => setTimeout(resolve, 500));
      return [{ label: "stale-completion", value: "stale-completion" }];
    },
    handler: async () => {},
  });
};
''')
        t = Terminal(root, "fullscreen", 90, ("-e", str(fixture)))
        try:
            t.wait(lambda: "[Extensions]" in t.frame(), "composition startup")
            t.send("/setmodel:2")
            t.wait(lambda: t.row("setmodel:2"), "assigned invocation name")
            t.send("\x1bOQ")  # F2, remapped completion key
            t.wait(lambda: t.input_is("/setmodel:2") and t.row("test-reasoner"), "custom key accepts command")
            t.send("\x1b[B")
            t.settle()
            t.send("\x1bOQ")
            t.wait(lambda: t.input_is("/setmodel:2 lab/test-plain") and t.row("off"), "custom key accepts second model")
            t.reset_input("/setmodel:2 lab/test-plain")

            t.send("/slow x")
            t.wait(lambda: t.input_is("/slow x"), "slow query input")
            deadline = time.monotonic() + 2
            while not started.exists() and time.monotonic() < deadline:
                t.pump(0.02)
            assert started.exists(), "slow callback did not start"
            t.send("\x15")
            t.wait(lambda: not t.input_is("/slow x"), "cancel pending input")
            target = "/setmodel:2 lab/test-reasoner"
            t.paste(target + " ")
            t.wait(lambda: t.input_is(target) and t.row("max"), "new query wins over delayed result")
            t.settle()
            assert not t.row("stale-completion"), t.frame()
        finally:
            t.close()
    print("PASS command collision, custom keybinding and stale-request cancellation")


if __name__ == "__main__":
    run("fullscreen", 100)
    run("regular", 64)
    run_composition()
