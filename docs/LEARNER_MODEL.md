# Learner model

**State per (learner, concept):** `p_known`, attempts, correct credit, memory `stability` (days), `last_reviewed_at`, `next_review_at`.

## Bayesian Knowledge Tracing
Parameters: prior 0.30, slip 0.10, learn 0.15, guess 0.25 (MCQ) / 0.10 (short answer) / 0.05 (numerical).

```
posterior_correct = p(1-slip) / (p(1-slip) + (1-p)·guess)
posterior_wrong   = p·slip   / (p·slip   + (1-p)(1-guess))
posterior         = c·posterior_correct + (1-c)·posterior_wrong      # c in [0,1] supports partial credit
p'                = posterior + (1-posterior)·learn
p_new             = p + weight·(p' - p)                              # weight scales evidence strength
```

## Evidence sources
| Source | Weight |
|---|---|
| Quiz / diagnostic answer | 1.0 (secondary concepts on the question 0.5) |
| "Quiz me on this" check in chat | 0.6 |
| Repeated question on one concept within an hour (confusion signal) | 0.25, counted as incorrect |
| Success on a concept → its prerequisites | 0.15, counted as correct |
| Failure on a concept → dependent concepts | 0.10, counted as incorrect |

## Forgetting and review
Retention `R(t) = exp(-t / stability)`. Stability doubles after a success (≥0.7) and shrinks ×0.6 after a miss (≤0.3), within 0.5–120 days. The next review is due when predicted retention reaches 80%.

## Choosing questions
Priority = (1 − p_known) + 0.5·(1 − retention) + 0.25 exploration bonus for never-tested concepts, plus +0.3 for weak prerequisites of weak concepts. Concepts are sampled with weight priority². Cold start uses a diagnostic that round-robins across topics. The study planner places weak concepts first and schedules reviews at +1, +3 and +7 days.
