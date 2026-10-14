"""Shared helpers for the StudyGraph evaluation scripts."""
import json
import os
import sys
import time
from pathlib import Path

import requests

BASE_URL = os.environ.get("STUDYGRAPH_URL", "http://localhost:3001").rstrip("/")
RESULTS = Path(__file__).parent / "results"
RESULTS.mkdir(exist_ok=True)


class Api:
    """Tiny client for the StudyGraph API (demo mode: no login needed)."""

    def __init__(self, learner: str | None = None):
        self.session = requests.Session()
        self.learner = learner

    def _headers(self):
        headers = {"Content-Type": "application/json"}
        if self.learner:
            headers["x-learner-id"] = self.learner
        return headers

    def _check(self, response):
        if not response.ok:
            try:
                message = response.json().get("error", response.text)
            except Exception:
                message = response.text
            raise RuntimeError(f"{response.request.method} {response.url} -> {response.status_code}: {message}")
        return response.json() if response.text else None

    def get(self, path, **params):
        return self._check(self.session.get(f"{BASE_URL}/api{path}", headers=self._headers(), params=params, timeout=300))

    def post(self, path, body=None):
        return self._check(self.session.post(f"{BASE_URL}/api{path}", headers=self._headers(), data=json.dumps(body or {}), timeout=600))


def pick_course(api: Api, course_id: str | None):
    courses = api.get("/courses")
    if not courses:
        sys.exit("No courses found. Create a course and ingest your material first.")
    if course_id:
        return course_id
    if len(courses) > 1:
        print("Several courses found; using the first. Pass --course-id to choose:")
        for c in courses:
            print(f"  {c['id']}  {c['name']}")
    return courses[0]["id"]


def stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")
