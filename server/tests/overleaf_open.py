#!/usr/bin/env python3
"""Open a synthetic Overleaf project using the real browser and CLI contracts."""

import html
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading
import unittest
import zipfile

import smoke


class OverleafFixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Cookie") != "overleaf_session2=fixture":
            self.send_error(403)
            return
        if self.path == "/project":
            dashboard = html.escape(json.dumps([
                {"id": "fixture-project", "name": "Browser Import", "accessLevel": "readOnly"},
            ]))
            payload = f'<meta name="ol-projects" content="{dashboard}">'.encode()
            content_type = "text/html"
        elif self.path == "/project/fixture-project/updates?min_count=1":
            payload = b'{"updates":[{"toV":1}]}'
            content_type = "application/json"
        elif self.path == "/project/fixture-project/download/zip":
            self.server.downloads += 1
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as project:
                project.writestr("main.tex", r"\documentclass{article}")
            payload = archive.getvalue()
            content_type = "application/zip"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


class OverleafOpen(unittest.TestCase):
    request = smoke.HeadlessSmoke.__dict__["request"]
    login = smoke.HeadlessSmoke.__dict__["login"]
    invoke = smoke.HeadlessSmoke.__dict__["invoke"]

    @classmethod
    def setUpClass(cls):
        smoke.HeadlessSmoke.setUpClass.__func__(cls)
        cls.addClassCleanup(smoke.HeadlessSmoke.tearDownClass.__func__, cls)
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), OverleafFixture)
        fixture.downloads = 0
        cls.fixture = fixture
        worker = threading.Thread(target=fixture.serve_forever)
        worker.start()
        cls.addClassCleanup(fixture.server_close)
        cls.addClassCleanup(worker.join, 5)
        cls.addClassCleanup(fixture.shutdown)
        code, reply = cls.invoke(cls, "overleaf_connect_session", {
            "host": f"http://127.0.0.1:{fixture.server_port}",
            "cookie": "overleaf_session2=fixture",
        })
        assert code == 200 and reply["result"]["connected"]

    def test_web_picker_imports_a_workspace_project(self):
        status, projects = self.invoke("overleaf_list_projects")
        self.assertEqual(status, 200, projects)
        project, = projects["result"]
        args = {"projectId": project["id"], "name": project["name"], "accessLevel": project["accessLevel"]}
        status, target = self.invoke("overleaf_clone_target", args)
        self.assertEqual(status, 200, target)
        self.assertEqual(target["result"]["kind"], "fresh")
        status, result = self.invoke("overleaf_clone_project", {**args, "adopt": False})
        self.assertEqual(status, 200, result)
        root = (self.workspace / "Browser Import").resolve()
        self.assertEqual(Path(result["result"]), root)
        self.assertFalse((self.workspace / "alpha" / "Browser Import").exists())
        status, _, body = self.request("GET", "/api/projects", cookie=self.cookie)
        self.assertEqual(status, 200, body)
        self.assertIn(str(root), [item["path"] for item in json.loads(body)])
        status, result = self.invoke("open_project", {"path": str(root)})
        self.assertEqual(status, 200, result)
        self.assertEqual(Path(result["result"]["root"]), root)
        self.assertEqual(
            self.invoke("read_project_file", {"path": "main.tex"})[1]["result"],
            r"\documentclass{article}",
        )

        status, target = self.invoke("overleaf_clone_target", args)
        self.assertEqual(status, 200, target)
        self.assertEqual(target["result"]["kind"], "open")
        downloads = self.fixture.downloads
        self.assertEqual(self.invoke("overleaf_clone_project", args), (200, {"result": str(root)}))
        self.assertEqual(self.fixture.downloads, downloads)
        saved = json.loads((root / ".research/overleaf.json").read_text())
        self.assertEqual(saved["permission"], "readOnly")

    def test_explicit_adoption_keeps_existing_files_and_other_links(self):
        args = {"name": "Local edits", "projectId": "fixture-project", "accessLevel": "readOnly"}
        folder = (self.workspace / "Local edits").resolve()
        folder.mkdir()
        (folder / "main.tex").write_text("local edit")
        code, reply = self.invoke("overleaf_clone_target", args)
        self.assertEqual(code, 200, reply)
        self.assertEqual(reply["result"]["kind"], "occupied")
        downloads = self.fixture.downloads
        self.assertEqual(self.invoke("overleaf_clone_project", {**args, "adopt": True}),
                         (200, {"result": str(folder)}))
        self.assertEqual((folder / "main.tex").read_text(), "local edit")
        self.assertEqual(self.fixture.downloads, downloads)
        # Another project sharing the title must never replace this link.
        code, reply = self.invoke("overleaf_clone_target", {**args, "projectId": "different"})
        self.assertEqual(code, 200, reply)
        self.assertEqual(reply["result"]["kind"], "fresh")
        self.assertEqual(reply["result"]["folder"], "Local edits (2)")

    def test_downloading_a_separate_copy_does_not_overwrite_unlinked_work(self):
        args = {"name": "Draft", "projectId": "fixture-project", "accessLevel": "readOnly"}
        local = (self.workspace / "Draft").resolve()
        local.mkdir()
        (local / "main.tex").write_text("local edit")
        status, result = self.invoke("overleaf_clone_project", {**args, "adopt": False})
        self.assertEqual(status, 200, result)
        downloaded = local.with_name("Draft (2)")
        self.assertEqual(result["result"], str(downloaded))
        self.assertEqual((local / "main.tex").read_text(), "local edit")
        self.assertEqual(self.invoke("overleaf_clone_target", args), (200, {"result": {
            "path": str(downloaded), "kind": "open", "folder": "Draft (2)",
        }}))

    def test_cli_accepts_legacy_project_name_in_selected_parent(self):
        parent = self.workspace / "beta"
        process = subprocess.run([
            smoke.BINARY, "invoke", "overleaf_clone_project",
            "--project", str(parent),
            "--state-dir", str(self.base / "state"),
        ], input=json.dumps({
            "projectId": "fixture-project",
            "projectName": "Legacy Import",
        }), capture_output=True, text=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(
            Path(json.loads(process.stdout)["result"]), (parent / "Legacy Import").resolve()
        )


if __name__ == "__main__":
    unittest.main()
