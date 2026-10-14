"""
Answer-key audit: how often is a generated question's key actually correct?

Step 1  python audit_keys.py --export 50 [--skip-verify-note]
        Generates quizzes and writes audit_sample.csv with each question, its
        key, and the source excerpt, plus an empty column "human_key_correct".
Step 2  Open the CSV and fill the column with yes/no after checking each key
        against the cited source.
Step 3  python audit_keys.py --score audit_sample.csv

To compare BEFORE vs AFTER cross-model validation: run the export once with the
API started with STUDYGRAPH_SKIP_VERIFY=true (before) and once normally
(after), label both, and score each file separately.
Requires ALLOW_SIM_KEYS=true on the API.
"""
import argparse
import csv
import json

from common import Api, pick_course


def export(n, course_id, out):
    api = Api(learner="audit")
    course_id = pick_course(api, course_id)
    rows = []
    while len(rows) < n:
        quiz = api.post(f"/x/courses/{course_id}/quiz", {"mode": "practice", "count": 8, "difficulty": "mixed", "types": ["mcq", "short", "numeric"], "strategy": "random"})["quiz"]
        for q in api.get(f"/x/quizzes/{quiz['id']}/sim-key")["questions"]:
            key = q["answerKey"]
            shown = q["options"][key["correctOption"]] if key["type"] == "mcq" else (key.get("modelAnswer") or f"{key.get('value')} {key.get('unit', '')}")
            rows.append({"id": q["id"], "type": q["type"], "prompt": q["prompt"], "options": json.dumps(q["options"], ensure_ascii=False) if q["options"] else "",
                         "key": shown, "verification": q["verification"]["status"], "source_excerpt": (q["citations"][0]["excerpt"] if q["citations"] else "")[:600],
                         "human_key_correct": ""})
    rows = rows[:n]
    with open(out, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} questions to {out}. Fill human_key_correct with yes/no, then run --score.")


def score(path):
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    labeled = [r for r in rows if r["human_key_correct"].strip().lower() in ("yes", "no")]
    if not labeled:
        raise SystemExit("No labeled rows. Fill human_key_correct with yes/no.")
    correct = sum(r["human_key_correct"].strip().lower() == "yes" for r in labeled)
    print(f"Labeled: {len(labeled)}  Key accuracy: {correct / len(labeled):.3f}")
    for status in sorted({r["verification"] for r in labeled}):
        group = [r for r in labeled if r["verification"] == status]
        ok = sum(r["human_key_correct"].strip().lower() == "yes" for r in group)
        print(f"  verification={status}: n={len(group)} accuracy={ok / len(group):.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--export", type=int)
    parser.add_argument("--score")
    parser.add_argument("--course-id")
    parser.add_argument("--out", default="audit_sample.csv")
    args = parser.parse_args()
    if args.export:
        export(args.export, args.course_id, args.out)
    elif args.score:
        score(args.score)
    else:
        parser.print_help()
