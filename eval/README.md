# Evaluation

Install: `pip install -r requirements.txt` and set `OPENAI_API_KEY`. The API must be running (`pnpm run dev`) with your course ingested.

| Step | Command | What it measures |
|---|---|---|
| 1 | `python build_testset.py --n 60` | Drafts a labeled test set (text, figure, cross-source, Hindi, off-material). **Review it by hand** and set `"reviewed": true`. |
| 2 | `python run_eval.py --reviewed-only` | RAGAS faithfulness, answer relevancy, context precision/recall; citation hit rate and precision; refusal accuracy; false-refusal rate |
| 3 | Start the API with `ALLOW_SIM_KEYS=true`, then `python simulate_students.py --sessions 5` | Mastery gain, estimate error and repetition rate for 4 profiles, adaptive vs random quizzing |
| 4 | `python audit_keys.py --export 50`, label the CSV, `python audit_keys.py --score audit_sample.csv` | Answer-key accuracy. Repeat with the API started with `STUDYGRAPH_SKIP_VERIFY=true` to get the before-validation figure |

Results are written to `results/`. Report weak numbers honestly; the rubric rewards rigor over polish.
Retrieval metrics use the units the tutor cited, not every internally retrieved unit.
