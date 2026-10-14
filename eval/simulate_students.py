"""
Simulated-student evaluation of personalization.

Each virtual student has a hidden set of concepts it truly knows. It takes
quizzes served by StudyGraph, answers according to its hidden knowledge (with
slips and guesses), and learns a concept with some probability when it is
quizzed on it and sees feedback. We run every profile twice from the same
starting knowledge: once with ADAPTIVE quizzing, once with RANDOM quizzing, and
compare true-knowledge gain, mastery-estimate accuracy and question repetition.

Requires the API to run with ALLOW_SIM_KEYS=true (so the simulator can read
answer keys). Costs OpenAI credits: keep --sessions and --count small.

Usage:  python simulate_students.py --sessions 5 --count 6 [--course-id ID]
"""
import argparse
import json
import random
import zlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from common import RESULTS, Api, pick_course, stamp  # noqa: E402

PROFILES = {
    "strong": {"known": 0.7, "slip": 0.05, "guess_extra": 0.0, "learn": 0.25, "forget": 0.0},
    "weak_in_one_topic": {"known": 0.7, "slip": 0.08, "guess_extra": 0.0, "learn": 0.25, "forget": 0.0, "weak_topic": True},
    "forgetful": {"known": 0.5, "slip": 0.1, "guess_extra": 0.0, "learn": 0.25, "forget": 0.08},
    "guesser": {"known": 0.3, "slip": 0.1, "guess_extra": 0.15, "learn": 0.2, "forget": 0.0},
}


def initial_knowledge(profile, concepts, topics, seed):
    rng = random.Random(seed)
    first_topic = topics[0]["id"] if topics else None
    known = set()
    for c in concepts:
        if profile.get("weak_topic") and c["topicId"] == first_topic:
            continue
        if rng.random() < profile["known"]:
            known.add(c["id"])
    return known


def run_student(api_factory, course_id, name, strategy, profile, concepts, topics, sessions, count, run_id):
    seed = zlib.crc32(name.encode()) % 10_000  # stable across runs
    known = initial_knowledge(profile, concepts, topics, seed)
    outcome_rng = random.Random(seed + (1 if strategy == "adaptive" else 2))
    api = api_factory(f"sim-{run_id}-{name}-{strategy}")
    total = len(concepts)
    curve = [len(known) / total]
    for session in range(1, sessions + 1):
        quiz = api.post(f"/x/courses/{course_id}/quiz", {"mode": "practice", "count": count, "difficulty": "mixed", "types": ["mcq", "numeric"], "strategy": strategy})["quiz"]
        keys = {q["id"]: q for q in api.get(f"/x/quizzes/{quiz['id']}/sim-key")["questions"]}
        answers, touched = [], set()
        for q in quiz["questions"]:
            key = keys[q["id"]]
            concept = (key["conceptIds"] or [None])[0]
            touched.update(key["conceptIds"][:1])
            knows = concept in known
            guess = 0.25 + profile["guess_extra"] if key["type"] == "mcq" else 0.02
            correct = outcome_rng.random() < ((1 - profile["slip"]) if knows else guess)
            ak = key["answerKey"]
            if key["type"] == "mcq":
                wrong = [i for i in range(len(key["options"])) if i != ak["correctOption"]]
                answer = ak["correctOption"] if correct else outcome_rng.choice(wrong)
            else:
                answer = str(ak["value"] if correct else ak["value"] * 1.7 + 3)
            answers.append({"questionId": q["id"], "answer": answer})
        api.post(f"/x/quizzes/{quiz['id']}/submit", {"answers": answers})
        for concept in touched:  # the student reads feedback and may learn
            if concept not in known and outcome_rng.random() < profile["learn"]:
                known.add(concept)
        for concept in list(known):  # forgetting between sessions
            if outcome_rng.random() < profile["forget"]:
                known.discard(concept)
        curve.append(len(known) / total)
        print(f"  {name}/{strategy} session {session}: true knowledge {curve[-1]:.2f}")

    mastery = api.get(f"/x/courses/{course_id}/mastery")
    tested = [c for c in mastery["concepts"] if c["attempts"] > 0]
    mae = sum(abs(c["pKnown"] - (1.0 if c["id"] in known else 0.0)) for c in tested) / len(tested) if tested else None
    return {"curve": curve, "gain": curve[-1] - curve[0], "estimate_mae": mae, "repetition_rate": mastery["questionStats"]["repetitionRate"],
            "questions_served": mastery["questionStats"]["kept"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-id")
    parser.add_argument("--sessions", type=int, default=5)
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--profiles", nargs="*", default=list(PROFILES))
    args = parser.parse_args()

    base_api = Api()
    course_id = pick_course(base_api, args.course_id)
    graph = base_api.get(f"/x/courses/{course_id}/graph")
    concepts, topics = graph["concepts"], graph["topics"]
    if len(concepts) < 8:
        raise SystemExit("The course needs at least ~8 concepts for a meaningful simulation.")
    run_id = stamp()
    results = {}
    for name in args.profiles:
        results[name] = {}
        for strategy in ("adaptive", "random"):
            print(f"Running {name} / {strategy}")
            results[name][strategy] = run_student(lambda learner: Api(learner), course_id, name, strategy, PROFILES[name], concepts, topics, args.sessions, args.count, run_id)

    fig, axes = plt.subplots(1, len(results), figsize=(4 * len(results), 3.4), sharey=True)
    axes = axes if hasattr(axes, "__len__") else [axes]
    for ax, (name, by_strategy) in zip(axes, results.items()):
        for strategy, color in (("adaptive", "#25473c"), ("random", "#c9776a")):
            ax.plot(by_strategy[strategy]["curve"], marker="o", label=strategy, color=color)
        ax.set_title(name.replace("_", " "))
        ax.set_xlabel("session")
        ax.grid(alpha=0.3)
    axes[0].set_ylabel("share of concepts truly known")
    axes[0].legend()
    fig.tight_layout()
    chart = RESULTS / f"simulation_{run_id}.png"
    fig.savefig(chart, dpi=160)

    lines = ["| Profile | Strategy | Knowledge gain | Estimate MAE | Repetition rate |", "|---|---|---|---|---|"]
    for name, by_strategy in results.items():
        for strategy, r in by_strategy.items():
            mae = "n/a" if r["estimate_mae"] is None else f"{r['estimate_mae']:.3f}"
            lines.append(f"| {name} | {strategy} | {r['gain']:+.3f} | {mae} | {r['repetition_rate']:.3f} |")
    (RESULTS / f"simulation_{run_id}.json").write_text(json.dumps({"args": vars(args), "results": results}, indent=2), encoding="utf-8")
    (RESULTS / f"simulation_{run_id}.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nChart: {chart}")
    print("Note: gains depend on the simulator's assumptions (learning/forgetting rates). Report them as simulated, not as real learning outcomes.")


if __name__ == "__main__":
    main()
