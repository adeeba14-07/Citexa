"""
Evaluates the retrieval + generation pipeline on the labeled test set.

Reports: faithfulness, answer relevancy, context precision and recall (RAGAS),
plus citation hit rate, citation precision, refusal accuracy and false-refusal
rate computed directly from the known source locations.

Usage:  python run_eval.py --testset testset.json [--reviewed-only] [--no-ragas]
"""
import argparse
import json
import statistics

from common import RESULTS, Api, stamp


def loc_matches(cited: dict, truth: dict) -> bool:
    """A citation matches ground truth if it is the same source and place."""
    if cited["sourceTitle"] != truth["source_title"]:
        return False
    a, b = cited["locator"], truth["locator"]
    if a.get("type") != b.get("type"):
        return False
    if a["type"] == "page":
        return a["page"] == b["page"]
    if a["type"] == "slide":
        return a["slide"] == b["slide"]
    return abs(a["start_sec"] - b["start_sec"]) <= 45


def mean(values):
    return round(statistics.fmean(values), 4) if values else None


def ragas_scores(rows):
    try:
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings
        from ragas import EvaluationDataset, evaluate
        from ragas.dataset_schema import SingleTurnSample
        from ragas.embeddings import LangchainEmbeddingsWrapper
        from ragas.llms import LangchainLLMWrapper
        from ragas.metrics import Faithfulness, LLMContextPrecisionWithReference, LLMContextRecall, ResponseRelevancy
    except Exception as error:  # noqa: BLE001
        print(f"RAGAS unavailable ({error}). Install requirements.txt (ragas 0.2.x) to enable it.")
        return None
    usable = [r for r in rows if r["answerable"] and r["supported"] and r["contexts"]]
    if not usable:
        return None
    samples = [SingleTurnSample(user_input=r["question"], response=r["answer"], retrieved_contexts=r["contexts"], reference=r["reference_answer"]) for r in usable]
    llm = LangchainLLMWrapper(ChatOpenAI(model="gpt-4o-mini", temperature=0))
    emb = LangchainEmbeddingsWrapper(OpenAIEmbeddings(model="text-embedding-3-small"))
    result = evaluate(EvaluationDataset(samples=samples), metrics=[Faithfulness(), ResponseRelevancy(), LLMContextPrecisionWithReference(), LLMContextRecall()], llm=llm, embeddings=emb)
    frame = result.to_pandas()
    out = {}
    for column in frame.columns:
        if column in ("user_input", "response", "retrieved_contexts", "reference"):
            continue
        values = [v for v in frame[column].tolist() if v == v]  # drop NaN
        out[column] = mean(values)
    out["n_samples"] = len(usable)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--testset", default="testset.json")
    parser.add_argument("--reviewed-only", action="store_true")
    parser.add_argument("--no-ragas", action="store_true")
    args = parser.parse_args()

    data = json.load(open(args.testset, encoding="utf-8"))
    course_id = data["course_id"]
    items = [i for i in data["items"] if i.get("reviewed") or not args.reviewed_only]
    api = Api()
    rows = []
    for number, item in enumerate(items, 1):
        print(f"[{number}/{len(items)}] {item['id']} {item['category']}")
        try:
            conversation = api.post(f"/courses/{course_id}/conversations", {"title": item["id"]})
            reply = api.post(f"/conversations/{conversation['id']}/messages", {"content": item["question"]})
        except Exception as error:  # noqa: BLE001
            print("  failed:", error)
            continue
        message = reply["assistantMessage"]
        citations = message["citations"]
        supported = reply["supportStatus"] == "supported"
        hits = [c for c in citations if any(loc_matches(c, t) for t in item["ground_truth"])]
        matched_truths = [t for t in item["ground_truth"] if any(loc_matches(c, t) for c in citations)]
        rows.append({**item, "answer": message["content"], "supported": supported, "n_citations": len(citations),
                     "n_matching_citations": len(hits), "truths_found": len(matched_truths),
                     "contexts": [c["excerpt"] for c in citations]})

    answerable = [r for r in rows if r["answerable"]]
    off = [r for r in rows if not r["answerable"]]
    summary = {
        "n_total": len(rows), "n_answerable": len(answerable), "n_off_material": len(off),
        "citation_hit_rate": mean([1.0 if r["n_matching_citations"] > 0 else 0.0 for r in answerable if r["supported"] or True]),
        "citation_precision": mean([r["n_matching_citations"] / r["n_citations"] for r in answerable if r["n_citations"]]),
        "cross_source_full_recall": mean([1.0 if r["truths_found"] == len(r["ground_truth"]) else 0.0 for r in answerable if r["category"] == "cross_source"]),
        "false_refusal_rate": mean([0.0 if r["supported"] else 1.0 for r in answerable]),
        "refusal_accuracy_off_material": mean([1.0 if not r["supported"] else 0.0 for r in off]),
    }
    by_category = {}
    for category in sorted({r["category"] for r in rows}):
        group = [r for r in rows if r["category"] == category]
        by_category[category] = {
            "n": len(group),
            "citation_hit_rate": mean([1.0 if r["n_matching_citations"] > 0 else 0.0 for r in group if r["answerable"]]),
            "refused": mean([0.0 if r["supported"] else 1.0 for r in group]),
        }
    summary["by_category"] = by_category
    summary["ragas"] = None if args.no_ragas else ragas_scores(rows)
    summary["reviewed_only"] = args.reviewed_only

    name = f"eval_{stamp()}"
    (RESULTS / f"{name}.json").write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [f"# Pipeline evaluation ({name})", "", "| Metric | Value |", "|---|---|"]
    for key, value in summary.items():
        if key in ("by_category", "ragas"):
            continue
        lines.append(f"| {key} | {value} |")
    if summary["ragas"]:
        for key, value in summary["ragas"].items():
            lines.append(f"| ragas.{key} | {value} |")
    lines += ["", "Note: retrieval metrics are computed on the units the tutor CITED (what a student sees), not on every unit retrieved internally."]
    (RESULTS / f"{name}.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nSaved to eval/results/{name}.json and .md")


if __name__ == "__main__":
    main()
