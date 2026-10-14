import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, CheckCircle2, ClipboardList, RotateCcw, Target, TimerReset, XCircle } from 'lucide-react';
import { useCreateQuiz, useGraph, useMastery, useSubmitQuiz } from './api';
import { card, CitationChips, ErrorNote, ghostBtn, primaryBtn, Spinner } from './common';
import type { Quiz, SubmitResponse } from './types';

type Mode = 'practice' | 'diagnostic' | 'mock';
type Answers = Record<string, string | number | null>;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const typeName = { mcq: 'Multiple choice', short: 'Short answer', numeric: 'Numerical' } as const;

function Badge({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'good' | 'warn' }) {
  const tones = { plain: 'border-[#d9d5c6] bg-[#f6f3e8] text-[#4d6358]', good: 'border-[#bcd5c5] bg-[#e7f1ea] text-[#2f6b4a]', warn: 'border-[#e3cf9f] bg-[#fbf6e6] text-[#8a6a1f]' };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
}

function Builder({ courseId, presetTopic, onCreated }: { courseId: string; presetTopic?: string; onCreated: (quiz: Quiz) => void }) {
  const mastery = useMastery(courseId);
  const graph = useGraph(courseId);
  const create = useCreateQuiz(courseId);
  const [mode, setMode] = useState<Mode>('practice');
  const [count, setCount] = useState(6);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard' | 'mixed'>('mixed');
  const [types, setTypes] = useState<string[]>(['mcq', 'short', 'numeric']);
  const [topicId, setTopicId] = useState(presetTopic ?? '');
  const [error, setError] = useState('');

  useEffect(() => { if (presetTopic) setTopicId(presetTopic); }, [presetTopic]);
  useEffect(() => { if (mastery.data?.needsDiagnostic) setMode('diagnostic'); }, [mastery.data?.needsDiagnostic]);
  useEffect(() => { setCount(mode === 'diagnostic' ? 8 : mode === 'mock' ? 12 : 6); }, [mode]);

  async function start() {
    setError('');
    try {
      onCreated(await create.mutateAsync({
        mode, count, difficulty,
        types: mode === 'diagnostic' ? ['mcq'] : types,
        topicId: mode === 'practice' && topicId ? topicId : undefined,
      }));
    } catch (e) { setError((e as Error).message); }
  }
  const toggleType = (t: string) => setTypes(prev => prev.includes(t) ? (prev.length > 1 ? prev.filter(x => x !== t) : prev) : [...prev, t]);

  const modes: { id: Mode; title: string; blurb: string }[] = [
    { id: 'diagnostic', title: 'Diagnostic', blurb: 'New here? A short broad quiz to estimate where you stand.' },
    { id: 'practice', title: 'Adaptive practice', blurb: 'Targets your weakest and most-forgotten concepts.' },
    { id: 'mock', title: 'Mock exam', blurb: 'Broad course coverage · 90 seconds per question · auto-submits.' },
  ];

  return <div className="space-y-5">
    {mastery.data?.needsDiagnostic && <div className="rounded-2xl border border-[#bcd5c5] bg-[#e7f1ea] p-4 text-sm text-[#2f6b4a]">Welcome! Take the diagnostic first so practice can adapt to you from the start.</div>}
    <div className="grid gap-3 sm:grid-cols-3">
      {modes.map(m => <button key={m.id} onClick={() => setMode(m.id)} className={`rounded-2xl border p-4 text-left transition ${mode === m.id ? 'border-[#25473c] bg-white shadow-sm' : 'border-[#e1ddd2] bg-[#fbfaf5] hover:bg-white'}`}>
        <div className="font-editorial text-xl text-[#25473c]">{m.title}</div><p className="mt-1 text-xs leading-5 text-[#718075]">{m.blurb}</p></button>)}
    </div>
    <div className={`${card} grid gap-5 sm:grid-cols-2`}>
      <label className="text-sm text-[#4d6358]">Number of questions: <b>{count}</b>
        <input type="range" min={mode === 'diagnostic' ? 5 : 3} max={mode === 'mock' ? 15 : 12} value={count} onChange={e => setCount(Number(e.target.value))} className="mt-2 block w-full accent-[#25473c]" /></label>
      <label className="text-sm text-[#4d6358]">Difficulty
        <select value={difficulty} onChange={e => setDifficulty(e.target.value as typeof difficulty)} className="mt-2 block w-full rounded-xl border border-[#d4d3c7] bg-white px-3 py-2">
          <option value="mixed">Mixed</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
      {mode !== 'diagnostic' && <fieldset className="text-sm text-[#4d6358]"><legend className="mb-2">Question types</legend>
        <div className="flex flex-wrap gap-2">{(['mcq', 'short', 'numeric'] as const).map(t => <button type="button" key={t} onClick={() => toggleType(t)} aria-pressed={types.includes(t)}
          className={`rounded-full border px-3 py-1.5 text-xs ${types.includes(t) ? 'border-[#25473c] bg-[#25473c] text-[#f7f3e8]' : 'border-[#d4d3c7] bg-white'}`}>{typeName[t]}</button>)}</div></fieldset>}
      {mode === 'practice' && <label className="text-sm text-[#4d6358]">Scope
        <select value={topicId} onChange={e => setTopicId(e.target.value)} className="mt-2 block w-full rounded-xl border border-[#d4d3c7] bg-white px-3 py-2">
          <option value="">Whole course (adaptive)</option>{graph.data?.topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
    </div>
    {error && <ErrorNote message={error} />}
    <div className="flex items-center gap-4">
      <button onClick={start} disabled={create.isPending} className={primaryBtn}><ClipboardList size={16} /> {create.isPending ? 'Building quiz…' : 'Start quiz'}</button>
      {create.isPending && <Spinner label="Writing questions, then checking each with a second model…" />}
    </div>
  </div>;
}

function Player({ courseId, quiz, onDone }: { courseId: string; quiz: Quiz; onDone: (r: SubmitResponse) => void }) {
  const submit = useSubmitQuiz(courseId);
  const [answers, setAnswers] = useState<Answers>({});
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const didSubmit = useRef(false);
  const timeLimit = quiz.questions.length * 90;
  useEffect(() => { const t = setInterval(() => setSeconds(s => quiz.mode === 'mock' ? Math.min(timeLimit, s + 1) : s + 1), 1000); return () => clearInterval(t); }, [quiz.mode, timeLimit]);
  const answered = quiz.questions.filter(q => answers[q.id] !== undefined && answers[q.id] !== '' && answers[q.id] !== null).length;
  const { stats } = quiz;

  async function finish() {
    if (didSubmit.current) return;
    didSubmit.current = true;
    setError('');
    try {
      onDone(await submit.mutateAsync({ quizId: quiz.id, answers: quiz.questions.map(q => ({ questionId: q.id, answer: answers[q.id] ?? null })) }));
    } catch (e) { didSubmit.current = false; setError((e as Error).message); }
  }

  useEffect(() => {
    if (quiz.mode === 'mock' && seconds >= timeLimit) void finish();
  }, [seconds, quiz.mode, timeLimit]);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><div className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-[#a67d4d]">{quiz.mode} · {quiz.questions.length} questions</div><h3 className="font-editorial text-3xl text-[#25473c]">{quiz.title}</h3></div>
      <div className={`flex items-center gap-2 text-sm ${quiz.mode === 'mock' && timeLimit - seconds <= 60 ? 'font-semibold text-[#a45e52]' : 'text-[#718075]'}`} aria-live="polite"><TimerReset size={15} />{quiz.mode === 'mock' ? `${Math.floor(Math.max(0, timeLimit - seconds) / 60)}:${String(Math.max(0, timeLimit - seconds) % 60).padStart(2, '0')} left` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</div>
    </div>
    <p className="rounded-xl border border-[#e1ddd2] bg-[#f4f1e6] px-4 py-2.5 text-xs leading-5 text-[#6c7a70]">
      Quality check: {stats.generated} questions drafted → {stats.rejectedVerification} rejected by a second model that solved them independently
      {stats.rejectedDuplicate > 0 && <> → {stats.rejectedDuplicate} repeats removed</>} → <b>{stats.kept} kept</b>.</p>
    {quiz.questions.map((q, index) => <section key={q.id} className={card} aria-label={`Question ${index + 1}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Q{index + 1}</Badge><Badge>{typeName[q.type]}</Badge><Badge>{q.difficulty}</Badge>
        {q.topic && <Badge>{q.topic.name}</Badge>}
        {q.verification.status === 'verified' && <Badge tone="good"><BadgeCheck size={12} /> Verified</Badge>}
      </div>
      <p className="mt-3 text-[15px] leading-7 text-[#25473c]">{q.prompt}</p>
      {q.type === 'mcq' && <div className="mt-3 grid gap-2" role="radiogroup" aria-label={`Options for question ${index + 1}`}>
        {q.options?.map((option, i) => <button key={option} role="radio" aria-checked={answers[q.id] === i} onClick={() => setAnswers(a => ({ ...a, [q.id]: i }))}
          className={`rounded-xl border px-4 py-2.5 text-left text-sm transition ${answers[q.id] === i ? 'border-[#25473c] bg-white shadow-sm' : 'border-[#dedbd0] bg-[#fbfaf5] hover:bg-white'}`}>
          <span className="font-mono-ui mr-2 text-xs text-[#a67d4d]">{String.fromCharCode(65 + i)}</span>{option}</button>)}</div>}
      {q.type === 'short' && <textarea aria-label={`Answer for question ${index + 1}`} rows={3} value={String(answers[q.id] ?? '')} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} placeholder="Write your answer in a few sentences…"
        className="mt-3 w-full rounded-xl border border-[#d4d3c7] bg-white px-4 py-3 text-sm outline-none focus:border-[#25473c]" />}
      {q.type === 'numeric' && <input aria-label={`Numeric answer for question ${index + 1}`} inputMode="decimal" value={String(answers[q.id] ?? '')} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} placeholder="Enter a number (include units if you like)"
        className="mt-3 w-full max-w-sm rounded-xl border border-[#d4d3c7] bg-white px-4 py-3 text-sm outline-none focus:border-[#25473c]" />}
      {quiz.mode !== 'mock' && <div className="mt-4"><div className="font-mono-ui mb-1.5 text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Where this comes from</div>
        <CitationChips citations={q.sources} compact /></div>}
    </section>)}
    {error && <ErrorNote message={error} />}
    <div className="flex items-center gap-4">
      <button onClick={finish} disabled={submit.isPending} className={primaryBtn}>{submit.isPending ? 'Grading…' : `Submit (${answered}/${quiz.questions.length} answered)`}</button>
      {submit.isPending && <Spinner label="Grading and updating your mastery…" />}
    </div>
  </div>;
}

function Results({ result, quiz, onAgain, onPractice }: { result: SubmitResponse; quiz: Quiz; onAgain: () => void; onPractice: () => void }) {
  const { report } = result;
  return <div className="space-y-6">
    <div className={`${card} flex flex-wrap items-center gap-6`}>
      <div className="grid h-24 w-24 place-items-center rounded-full border-[6px] border-[#25473c] font-editorial text-3xl text-[#25473c]">{report.percentage}%</div>
      <div><div className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-[#a67d4d]">Result</div>
        <h3 className="font-editorial text-3xl text-[#25473c]">{Number(result.score.toFixed(2))} of {result.total} points</h3>
        <p className="mt-1 text-sm text-[#718075]">{quiz.title}</p></div>
    </div>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className={card}><h4 className="font-editorial text-xl text-[#25473c]">By topic</h4>
        <div className="mt-3 space-y-3">{report.byTopic.map(t => <div key={t.topic}>
          <div className="flex justify-between text-sm text-[#4d6358]"><span>{t.topic}</span><span>{Number(t.earned.toFixed(2))}/{t.total}</span></div>
          <div className="mt-1 h-2 rounded-full bg-[#e8e4d6]"><div className="h-2 rounded-full bg-[#25473c]" style={{ width: `${(t.earned / Math.max(1, t.total)) * 100}%` }} /></div></div>)}</div></section>
      <section className={card}><h4 className="font-editorial text-xl text-[#25473c]">Weak topics</h4>
        {report.weakTopics.length === 0 ? <p className="mt-3 text-sm text-[#718075]">No weak topics in this quiz. Nice work.</p>
          : <ul className="mt-3 space-y-2 text-sm text-[#4d6358]">{report.weakTopics.map(t => <li key={t.topic} className="flex items-center gap-2"><Target size={14} className="text-[#c9776a]" /><span className="font-medium">{t.topic}</span><span className="text-[#718075]">{pct(t.accuracy)} correct{t.mastery !== null ? ` · mastery ${pct(t.mastery)}` : ''}</span></li>)}</ul>}</section>
    </div>

    {report.misconceptions.length > 0 && <section className={card}><h4 className="font-editorial text-xl text-[#25473c]">Likely misconceptions</h4>
      <div className="mt-3 space-y-4">{report.misconceptions.map(m => <div key={m.label} className="rounded-xl border border-[#e3cf9f] bg-[#fbf6e6] p-4">
        <p className="text-sm font-semibold text-[#6e5518]">{m.label}{m.count > 1 ? ` (×${m.count})` : ''}</p>
        <p className="mt-0.5 text-xs text-[#8a7a4a]">Concept: {m.concept}</p><div className="mt-2"><CitationChips citations={m.citations} compact /></div></div>)}</div></section>}

    <section className={card}><h4 className="font-editorial text-xl text-[#25473c]">Recommended next steps</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[#4d6358]">{report.nextSteps.map(s => <li key={s}>{s}</li>)}</ul></section>

    <section><h4 className="font-editorial text-2xl text-[#25473c]">Question feedback</h4>
      <div className="mt-3 space-y-4">{result.results.map((r, i) => <article key={r.questionId} className={`${card} ${r.isCorrect ? 'border-[#bcd5c5]' : 'border-[#e5c7c0]'}`}>
        <div className="flex items-start gap-3">{r.isCorrect ? <CheckCircle2 className="mt-0.5 shrink-0 text-[#4f8a6a]" size={20} /> : <XCircle className="mt-0.5 shrink-0 text-[#c9776a]" size={20} />}
          <div className="min-w-0 flex-1"><p className="text-sm font-medium text-[#25473c]">{i + 1}. {r.prompt}</p>
            <p className="mt-2 text-sm text-[#4d6358]"><span className="text-[#718075]">Your answer:</span> {r.yourAnswer}</p>
            {!r.isCorrect && <p className="text-sm text-[#4d6358]"><span className="text-[#718075]">Expected:</span> {r.correctAnswer}</p>}
            {r.type === 'short' && <p className="text-xs text-[#718075]">Score {Number(r.score)} of 1 (rubric-graded)</p>}
            <p className="mt-2 text-sm leading-6 text-[#3d5348]">{r.feedback}</p>
            {r.explanation && <p className="mt-1 text-sm leading-6 text-[#718075]">{r.explanation}</p>}
            <div className="mt-3"><CitationChips citations={r.citations} compact /></div></div></div></article>)}</div></section>

    <section className={card}><h4 className="font-editorial text-xl text-[#25473c]">Mastery updated</h4>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">{result.mastery.slice(0, 12).map(m => <div key={m.conceptId} className="text-sm text-[#4d6358]">
        <div className="flex justify-between"><span className="truncate pr-2">{m.name}</span><span className="font-mono-ui text-xs text-[#718075]">{pct(m.before)} → {pct(m.after)}</span></div>
        <div className="relative mt-1 h-2 rounded-full bg-[#e8e4d6]"><div className="absolute h-2 rounded-full bg-[#c9d6cd]" style={{ width: pct(Math.max(m.before, m.after)) }} /><div className="absolute h-2 rounded-full bg-[#25473c]" style={{ width: pct(Math.min(m.before, m.after)) }} /></div></div>)}</div></section>

    <div className="flex flex-wrap gap-3"><button onClick={onAgain} className={primaryBtn}><RotateCcw size={15} /> Another quiz</button>
      <button onClick={onPractice} className={ghostBtn}>Practice my weak spots</button></div>
  </div>;
}

export function QuizPanel({ courseId, presetTopic }: { courseId: string; presetTopic?: string }) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const create = useCreateQuiz(courseId);
  const [error, setError] = useState('');

  async function practiceWeak() {
    setError('');
    try { setResult(null); setQuiz(await create.mutateAsync({ mode: 'practice', count: 6, difficulty: 'mixed' })); }
    catch (e) { setError((e as Error).message); }
  }

  if (quiz && result) return <Results result={result} quiz={quiz} onAgain={() => { setQuiz(null); setResult(null); }} onPractice={practiceWeak} />;
  if (quiz) return <Player key={quiz.id} courseId={courseId} quiz={quiz} onDone={setResult} />;
  return <>
    <Builder courseId={courseId} presetTopic={presetTopic} onCreated={setQuiz} />
    {create.isPending && <div className="mt-4"><Spinner label="Building your next quiz…" /></div>}
    {error && <div className="mt-4"><ErrorNote message={error} /></div>}
  </>;
}
