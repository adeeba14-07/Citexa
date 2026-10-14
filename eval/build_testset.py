"""
Builds a DRAFT evaluation test set from your ingested course.

Every question is tied to the exact unit(s) (source + page/slide/timestamp) it
was written from, so retrieval and citation accuracy can be measured. Off-
material questions are generated too, to test refusals.

IMPORTANT: this is a draft. Read through it and fix or delete weak questions
(set "reviewed": true as you go). Report only reviewed items in your results.

Usage:  python build_testset.py --n 60 [--course-id ID] [--out testset.json]
"""
import argparse
import json
import os
import random

from openai import OpenAI

from common import Api, pick_course

MODEL = os.environ.get("EVAL_GEN_MODEL", "gpt-4.1-mini")
client = OpenAI()


def ask_json(system: str, user: str) -> dict:
    out = client.chat.completions.create(
        model=MODEL, response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    return json.loads(out.choices[0].message.content)


def gt(unit):
    return {"unit_id": unit["id"], "source_title": unit["sourceTitle"], "locator": unit["locator"]}


def qa_from_unit(unit, figure=False):
    text = (unit.get("figureCaption") or "") + "\n" + unit["text"]
    system = ("Write ONE exam-style question that can be answered only from the given course excerpt, plus a concise reference answer. "
              + ("The question must depend on the figure/diagram content. " if figure else "")
              + 'Return JSON {"question": str, "reference_answer": str}.')
    return ask_json(system, text[:2500])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=60)
    parser.add_argument("--course-id")
    parser.add_argument("--out", default="testset.json")
    args = parser.parse_args()

    api = Api()
    course_id = pick_course(api, args.course_id)
    units = [u for u in api.get(f"/x/courses/{course_id}/units")["units"] if len(u["text"]) > 250]
    if len(units) < 10:
        raise SystemExit("Not enough extracted units. Process more material first.")
    random.seed(7)
    figure_units = [u for u in units if u.get("figureCaption")]
    plain_units = [u for u in units if not u.get("figureCaption")]

    n_off = max(4, round(args.n * 0.25))
    n_fig = min(len(figure_units), max(3, round(args.n * 0.15)))
    n_cross = max(3, round(args.n * 0.1))
    n_hindi = max(3, round(args.n * 0.1))
    n_text = max(5, args.n - n_off - n_fig - n_cross - n_hindi)

    items = []
    for unit in random.sample(plain_units, min(n_text, len(plain_units))):
        qa = qa_from_unit(unit)
        items.append({"category": "text", "question": qa["question"], "reference_answer": qa["reference_answer"], "answerable": True, "ground_truth": [gt(unit)]})
    for unit in random.sample(figure_units, n_fig):
        qa = qa_from_unit(unit, figure=True)
        items.append({"category": "figure", "question": qa["question"], "reference_answer": qa["reference_answer"], "answerable": True, "ground_truth": [gt(unit)]})

    by_source = {}
    for u in units:
        by_source.setdefault(u["sourceTitle"], []).append(u)
    if len(by_source) >= 2:
        for _ in range(n_cross):
            a, b = random.sample(list(by_source), 2)
            ua, ub = random.choice(by_source[a]), random.choice(by_source[b])
            out = ask_json('Write ONE question that needs BOTH excerpts to answer fully, plus a concise reference answer. Return JSON {"question": str, "reference_answer": str}.',
                           f"EXCERPT A:\n{ua['text'][:1500]}\n\nEXCERPT B:\n{ub['text'][:1500]}")
            items.append({"category": "cross_source", "question": out["question"], "reference_answer": out["reference_answer"], "answerable": True, "ground_truth": [gt(ua), gt(ub)]})

    answerable = [i for i in items if i["category"] in ("text", "figure")]
    for item in random.sample(answerable, min(n_hindi, len(answerable))):
        out = ask_json('Translate the question into natural Hindi (Devanagari). Return JSON {"question": str}.', item["question"])
        items.append({"category": "hindi", "question": out["question"], "reference_answer": item["reference_answer"], "answerable": True, "ground_truth": item["ground_truth"]})

    titles = ", ".join(sorted(by_source)[:12])
    off = ask_json(f'The course material is: {titles}. Write {n_off} questions the material does NOT cover: half completely unrelated (sports, cooking, celebrities), half plausible for the same field but outside this material. Return JSON {{"questions": [str]}}.', "Write them.")
    for question in off["questions"][:n_off]:
        items.append({"category": "off_material", "question": question, "reference_answer": "", "answerable": False, "ground_truth": []})

    random.shuffle(items)
    for index, item in enumerate(items, 1):
        item["id"] = f"q{index:03d}"
        item["reviewed"] = False
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"course_id": course_id, "items": items}, handle, ensure_ascii=False, indent=2)
    counts = {}
    for item in items:
        counts[item["category"]] = counts.get(item["category"], 0) + 1
    print(f"Wrote {len(items)} draft questions to {args.out}: {counts}")
    print("Now REVIEW the file and set \"reviewed\": true on questions you have checked.")


if __name__ == "__main__":
    main()
