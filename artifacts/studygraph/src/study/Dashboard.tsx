import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Clock3, ShieldCheck } from 'lucide-react';
import { useMastery } from './api';
import { card, CitationChips, ErrorNote, primaryBtn, statusColor } from './common';

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className={card}><div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">{label}</div>
    <div className="mt-1 font-editorial text-4xl text-[#25473c]">{value}</div>{hint && <p className="mt-1 text-xs text-[#718075]">{hint}</p>}</div>;
}

export function Dashboard({ courseId, onStartQuiz }: { courseId: string; onStartQuiz: () => void }) {
  const { data, isLoading, isError, error } = useMastery(courseId);
  if (isLoading) return <div className="grid gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton h-28 rounded-2xl" />)}</div>;
  if (isError || !data) return <ErrorNote message={(error as Error)?.message ?? 'Could not load your dashboard.'} />;

  const byTopic = new Map<string, typeof data.concepts>();
  for (const c of data.concepts) byTopic.set(c.topic, [...(byTopic.get(c.topic) ?? []), c]);
  const due = data.concepts.filter(c => c.due).slice(0, 6);
  const q = data.questionStats;
  const chart = data.history.map(h => ({ n: h.i, mastery: Math.round(h.average * 100), source: h.source }));

  return <div className="space-y-6">
    {data.needsDiagnostic && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#bcd5c5] bg-[#e7f1ea] p-4">
      <p className="text-sm text-[#2f6b4a]">No quiz history yet. A short diagnostic gives the tutor a starting picture of what you know.</p>
      <button onClick={onStartQuiz} className={primaryBtn}>Take the diagnostic</button></div>}

    <details className="rounded-2xl border border-[#e0dccb] bg-[#fbf9f1] p-4 text-sm leading-6 text-[#4b5f52]" open={data.summary.testedConcepts === 0}>
      <summary className="cursor-pointer font-semibold text-[#25473c]">How to read this dashboard</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><b>Concepts</b> are the ideas Citexa found in your sources (grouped under topics). Each small square below is one concept.</li>
        <li><b>Mastery</b> is Citexa's estimate (0–100%) of how well you know a concept, updated after each quiz answer and tutor check. Grey = not tested yet, red = weak, yellow = learning, green = strong.</li>
        <li><b>Due for review</b> means you probably started to forget it, so a quick quiz on it is worth doing now.</li>
        <li>Take a quiz from the <b>Quizzes</b> tab and the squares and the trend chart will fill in. Hover or click a square to see why it has its current score.</li>
      </ul>
    </details>

    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Average mastery" value={pct(data.summary.averageMastery)} hint={`${data.summary.testedConcepts} of ${data.summary.totalConcepts} concepts tested`} />
      <Stat label="Weak concepts" value={String(data.summary.weakConcepts)} hint="Below 55% estimated mastery" />
      <Stat label="Due for review" value={String(data.summary.dueConcepts)} hint="Predicted retention fell under 80%" />
      <Stat label="Quizzes taken" value={String(data.recentAttempts.length)} hint="Most recent 10 shown below" />
    </div>

    <section className={card}><h3 className="font-editorial text-2xl text-[#25473c]">Mastery over time</h3>
      <p className="text-xs text-[#718075]">Average estimated mastery across tested concepts, after every quiz and chat signal.</p>
      {chart.length < 2 ? <p className="mt-4 text-sm text-[#718075]">Take a quiz or two and the trend will appear here.</p> :
        <div className="mt-4 h-60"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#e8e4d6" vertical={false} /><XAxis dataKey="n" tick={{ fontSize: 11, fill: '#718075' }} /><YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#718075' }} unit="%" />
          <Tooltip formatter={(v: number) => [`${v}%`, 'Mastery']} labelFormatter={(l: number) => `Update ${l}`} />
          <Line type="monotone" dataKey="mastery" stroke="#25473c" strokeWidth={2.5} dot={false} /></LineChart></ResponsiveContainer></div>}</section>

    <section className={card}><h3 className="font-editorial text-2xl text-[#25473c]">Concept mastery</h3>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-[#718075]">
        {[['untested', 0], ['weak', 0.2], ['learning', 0.6], ['strong', 0.9]].map(([label, p]) => <span key={label as string} className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded" style={{ background: statusColor(label as string, p as number) }} />{label as string}</span>)}</div>
      <div className="mt-4 space-y-4">{[...byTopic.entries()].map(([topic, concepts]) => <div key={topic}>
        <div className="mb-1.5 text-sm font-medium text-[#365647]">{topic}</div>
        <div className="flex flex-wrap gap-1.5">{concepts.map(c => <div key={c.id} tabIndex={0} title={`${c.name} · ${c.status}${c.attempts ? ` · ${pct(c.pKnown)}` : ''}`} aria-label={`${c.name}: ${c.status}`}
          className="h-7 w-7 rounded-md outline-offset-2 focus:outline focus:outline-2 focus:outline-[#25473c]" style={{ background: statusColor(c.status, c.pKnown) }} />)}</div></div>)}
        {byTopic.size === 0 && <p className="text-sm text-[#718075]">Concepts appear once a source has finished processing.</p>}</div></section>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className={card}><h3 className="font-editorial text-2xl text-[#25473c]">Focus next</h3>
        <ul className="mt-3 space-y-2">{data.weakConcepts.map(c => <li key={c.id} className="flex items-center justify-between gap-3 text-sm text-[#4d6358]">
          <span className="truncate">{c.name}</span><span className="font-mono-ui shrink-0 text-xs text-[#718075]">{c.attempts ? pct(c.pKnown) : 'untested'}</span></li>)}</ul>
        {due.length > 0 && <div className="mt-4 border-t border-[#e8e4d6] pt-3"><div className="font-mono-ui mb-2 text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Due for review</div>
          <ul className="space-y-1.5">{due.map(c => <li key={c.id} className="flex items-center gap-2 text-sm text-[#4d6358]"><Clock3 size={13} className="text-[#c9776a]" />{c.name}</li>)}</ul></div>}</section>
      <section className={card}><h3 className="font-editorial text-2xl text-[#25473c]">Likely misconceptions</h3>
        {data.misconceptions.length === 0 ? <p className="mt-3 text-sm text-[#718075]">None detected yet. They appear when a wrong answer matches a known misconception.</p>
          : <div className="mt-3 space-y-3">{data.misconceptions.map(m => <div key={m.label} className="rounded-xl border border-[#e3cf9f] bg-[#fbf6e6] p-3">
            <p className="text-sm font-semibold text-[#6e5518]">{m.label}{m.count > 1 ? ` (×${m.count})` : ''}</p><p className="text-xs text-[#8a7a4a]">{m.concept}</p>
            <div className="mt-2"><CitationChips citations={m.citations} compact /></div></div>)}</div>}</section>
    </div>

    <section className={card}><h3 className="flex items-center gap-2 font-editorial text-2xl text-[#25473c]"><ShieldCheck size={20} /> Question quality</h3>
      <div className="mt-3 grid gap-4 text-sm text-[#4d6358] sm:grid-cols-4">
        <div><div className="font-editorial text-3xl text-[#25473c]">{q.generated}</div>questions drafted</div>
        <div><div className="font-editorial text-3xl text-[#25473c]">{q.rejectedVerification}</div>rejected by cross-model check</div>
        <div><div className="font-editorial text-3xl text-[#25473c]">{q.rejectedDuplicate}</div>repeats removed</div>
        <div><div className="font-editorial text-3xl text-[#25473c]">{pct(q.repetitionRate)}</div>repetition rate served</div></div></section>

    {data.recentAttempts.length > 0 && <section className={card}><h3 className="font-editorial text-2xl text-[#25473c]">Recent quizzes</h3>
      <ul className="mt-3 divide-y divide-[#e8e4d6]">{data.recentAttempts.map(a => <li key={a.id} className="flex items-center justify-between py-2 text-sm text-[#4d6358]">
        <span className="capitalize">{a.mode}</span><span>{Number(a.score.toFixed(1))}/{a.total}</span><span className="text-xs text-[#718075]">{new Date(a.createdAt).toLocaleString()}</span></li>)}</ul></section>}
  </div>;
}
