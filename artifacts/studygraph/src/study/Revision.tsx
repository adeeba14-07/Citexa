import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, Flame, Layers, Printer, RotateCcw } from 'lucide-react';
import { useCreateSavedPlan, useFlashcards, useMastery, usePlan, useSavedPlans, useUpdateSavedPlan } from './api';
import { card, CitationChips, ErrorNote, ghostBtn, primaryBtn, Spinner } from './common';
import type { Flashcard } from './types';
import type { SavedPlan } from './api';

function planStorageKey(courseId: string) { return `citexa:study-plan:v1:${courseId}`; }

function readLegacyPlan(courseId: string) {
  try {
    const raw = localStorage.getItem(planStorageKey(courseId));
    if (!raw) return null;
    const value = JSON.parse(raw) as { examDate?: unknown; minutesPerDay?: unknown; schedule?: unknown; completed?: unknown; savedAt?: unknown };
    if (typeof value.examDate !== 'string' || !Array.isArray(value.schedule) || !Array.isArray(value.completed)) return null;
    return {
      examDate: value.examDate,
      minutesPerDay: Number(value.minutesPerDay) || 45,
      schedule: value.schedule as import('./types').PlanDay[],
      completed: value.completed.filter((item): item is string => typeof item === 'string'),
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
    };
  } catch { return null; }
}

function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function printFlashcards(cards: Flashcard[]) {
  const report = window.open('', '_blank');
  if (!report) { window.alert('Allow pop-ups for Citexa to print or save your flashcards as a PDF.'); return; }
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
  const pages = cards.map((item, index) => {
    const location = item.citations.map(c => `${c.sourceTitle} · ${c.locator.type === 'page' ? `Page ${c.locator.page}` : c.locator.type === 'slide' ? `Slide ${c.locator.slide}` : `${Math.floor(c.locator.start_sec / 60)}:${String(Math.floor(c.locator.start_sec % 60)).padStart(2, '0')}`}`).join(', ');
    return `<article><div class="number">Card ${index + 1}</div><h2>Question</h2><p>${escape(item.front)}</p><h2>Answer</h2><p>${escape(item.back)}</p><small>From your course: ${escape(location)}</small></article>`;
  }).join('');
  report.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Citexa flashcards</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#25473c;max-width:800px;margin:32px auto;padding:20px}button{background:#25473c;color:white;border:0;border-radius:24px;padding:12px 18px;font-weight:700;cursor:pointer}article{border:1px solid #dedbd0;border-radius:16px;padding:22px;margin:20px 0;break-inside:avoid}.number,small{color:#7b765f}h2{font-size:14px;margin-bottom:4px}p{white-space:pre-wrap}@media print{button{display:none}body{margin:0 auto}}</style></head><body><button onclick="window.print()">Print / Save as PDF</button><h1>Your study flashcards</h1><p>Use this simple printable copy to review your questions and answers.</p>${pages}</body></html>`);
  report.document.close();
}

function DailyReviewQueue({ courseId, onStartQuiz }: { courseId: string; onStartQuiz: () => void }) {
  const mastery = useMastery(courseId);
  const due = (mastery.data?.concepts ?? []).filter(concept => concept.due).sort((a, b) => b.priority - a.priority).slice(0, 8);
  return <section className={`${card} border-[#d7e0d4] bg-gradient-to-br from-[#f4f7ef] to-[#fbfaf5]`}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-[#a67d4d]">Adaptive revision</div><h3 className="mt-1 font-editorial text-2xl text-[#25473c]">Today’s review queue</h3><p className="mt-1 text-sm text-[#718075]">Concepts due on your forgetting curve, ordered by review priority.</p></div>
      <button className={primaryBtn} disabled={mastery.isLoading || due.length === 0} onClick={onStartQuiz}>{mastery.isLoading ? 'Loading queue…' : due.length ? `Review ${due.length} due ${due.length === 1 ? 'concept' : 'concepts'}` : 'Nothing due today'}</button>
    </div>
    {mastery.isError && <div className="mt-3"><ErrorNote message={(mastery.error as Error).message} /></div>}
    {!mastery.isLoading && due.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{due.map(item => <span key={item.id} className="rounded-full border border-[#d8dfd4] bg-white/80 px-3 py-1.5 text-xs text-[#4d6358]">{item.name}<span className="ml-2 text-[#9aa398]">{Math.round(item.pKnown * 100)}% mastery</span></span>)}</div>}
    {!mastery.isLoading && !due.length && !mastery.isError && <p className="mt-3 rounded-xl bg-white/70 p-3 text-sm text-[#637568]">Your queue is clear for now. Quiz activity refreshes this queue as concepts become due.</p>}
  </section>;
}

function FlashcardDeck({ courseId }: { courseId: string }) {
  const make = useFlashcards(courseId);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const cards = make.data ?? [];
  const current = cards[index];
  return <section className={card}>
    <h3 className="flex items-center gap-2 font-editorial text-2xl text-[#25473c]"><Layers size={20} /> Flashcards for weak topics</h3>
    <p className="mt-1 text-sm text-[#718075]">Built from the concepts you know least, each card linked to its source.</p>
    <div className="mt-4"><button className={primaryBtn} disabled={make.isPending} onClick={() => { setIndex(0); setFlipped(false); make.mutate(8); }}>{make.isPending ? 'Making cards…' : cards.length ? 'Make a new set' : 'Generate flashcards'}</button></div>
    {make.isPending && <div className="mt-3"><Spinner label="Reading your weakest concepts…" /></div>}
    {make.isError && <div className="mt-3"><ErrorNote message={(make.error as Error).message} /></div>}
    {current && <div className="mt-5">
      <button className={`${ghostBtn} mb-3`} onClick={() => printFlashcards(cards)}><Printer size={14} /> Print / save flashcards as PDF</button>
      <button onClick={() => setFlipped(f => !f)} aria-label="Flip card" className="block min-h-[170px] w-full rounded-2xl border border-[#d9d5c6] bg-white p-6 text-left transition hover:shadow-md">
        <div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">{flipped ? 'Answer' : 'Question'} · {index + 1}/{cards.length}</div>
        <p className="mt-3 text-lg leading-8 text-[#25473c]">{flipped ? current.back : current.front}</p></button>
      <div className="mt-3"><CitationChips citations={current.citations} compact /></div>
      <div className="mt-3 flex gap-2"><button className={ghostBtn} disabled={index === 0} onClick={() => { setIndex(i => i - 1); setFlipped(false); }}>Previous</button>
        <button className={ghostBtn} disabled={index >= cards.length - 1} onClick={() => { setIndex(i => i + 1); setFlipped(false); }}>Next</button></div></div>}
  </section>;
}

function Planner({ courseId }: { courseId: string }) {
  const plan = usePlan(courseId);
  const savedPlans = useSavedPlans(courseId);
  const createSavedPlan = useCreateSavedPlan(courseId);
  const updateSavedPlan = useUpdateSavedPlan(courseId);
  const legacyImported = useRef(false);
  const initialLegacy = useRef(readLegacyPlan(courseId));
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [examDate, setExamDate] = useState(() => initialLegacy.current?.examDate ?? localDayKey(new Date(Date.now() + 7 * 86_400_000)));
  const [minutes, setMinutes] = useState(() => initialLegacy.current?.minutesPerDay ?? 45);
  const savedPlan = savedPlans.data?.find(item => item.id === selectedPlanId) ?? savedPlans.data?.[0] ?? null;
  const maxExamDate = localDayKey(new Date(Date.now() + 60 * 86_400_000));

  useEffect(() => {
    if (!selectedPlanId && savedPlans.data?.length) setSelectedPlanId(savedPlans.data[0].id);
  }, [savedPlans.data, selectedPlanId]);
  useEffect(() => {
    if (savedPlans.isFetched && !savedPlans.isError && !savedPlans.data?.length && !legacyImported.current && initialLegacy.current) {
      legacyImported.current = true;
      const { examDate: oldExamDate, minutesPerDay, schedule, completed } = initialLegacy.current;
      void createSavedPlan.mutateAsync({ examDate: oldExamDate, minutesPerDay, schedule, completed })
        .then(created => {
          setSelectedPlanId(created.id);
          localStorage.removeItem(planStorageKey(courseId));
        }).catch(() => { legacyImported.current = false; /* keep the legacy browser copy if account sync fails */ });
    }
  }, [courseId, createSavedPlan, savedPlans.data, savedPlans.isFetched, savedPlans.isError]);
  useEffect(() => {
    if (savedPlan) {
      setExamDate(savedPlan.examDate);
      setMinutes(savedPlan.minutesPerDay);
    }
  }, [savedPlan?.id]);

  const taskCount = useMemo(() => savedPlan?.schedule.reduce((sum, day) => sum + day.tasks.length, 0) ?? 0, [savedPlan]);
  const completeCount = savedPlan?.completed.length ?? 0;
  const completionDates = useMemo(() => new Set((savedPlan?.completed ?? []).map(key => key.slice(0, 10))), [savedPlan]);
  const streak = useMemo(() => {
    if (!completionDates.size) return 0;
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    const today = localDayKey(cursor);
    if (!completionDates.has(today)) cursor.setDate(cursor.getDate() - 1);
    let count = 0;
    while (completionDates.has(localDayKey(cursor))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }, [completionDates]);

  async function buildPlan() {
    try {
      const response = await plan.mutateAsync({ examDate, minutesPerDay: minutes });
      const next = await createSavedPlan.mutateAsync({
        examDate: response.examDate ?? examDate,
        minutesPerDay: response.minutesPerDay ?? minutes,
        schedule: response.schedule,
        completed: [],
      });
      setSelectedPlanId(next.id);
      setExamDate(next.examDate);
      setMinutes(next.minutesPerDay);
    } catch { /* the mutation's inline error state is shown below */ }
  }

  async function toggleTask(key: string) {
    if (!savedPlan || updateSavedPlan.isPending) return;
    const completed = savedPlan.completed.includes(key)
      ? savedPlan.completed.filter(item => item !== key)
      : [...savedPlan.completed, key];
    await updateSavedPlan.mutateAsync({ id: savedPlan.id, completed }).catch(() => undefined);
  }

  return <section className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="flex items-center gap-2 font-editorial text-2xl text-[#25473c]"><CalendarDays size={20} /> Study schedule</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-[#718075]">Weak concepts first, with spaced reviews 1, 3 and 7 days later, ending in a mock exam. Plans and checked tasks are saved to your account.</p>
      </div>
      {savedPlan && <div className="inline-flex items-center gap-1.5 rounded-full bg-[#fff3dc] px-3 py-1.5 text-xs font-semibold text-[#8a6a1f]"><Flame size={14} /> {streak}-day revision streak</div>}
    </div>
    {savedPlans.isLoading && <div className="mt-4"><Spinner label="Loading your saved plans…" /></div>}
    {savedPlans.isError && <div className="mt-3"><ErrorNote message={(savedPlans.error as Error).message} /><button onClick={() => void savedPlans.refetch()} className="mt-2 text-xs font-semibold text-[#365647] underline">Retry loading saved plans</button></div>}
    {savedPlans.isFetched && !savedPlans.isError && savedPlans.data?.length === 0 && <p className="mt-4 rounded-xl bg-[#f1eee4] p-3 text-sm text-[#718075]">No saved plans yet. Build your first schedule and it will stay with your account.</p>}
    {savedPlans.data && savedPlans.data.length > 1 && <label className="mt-4 block max-w-sm text-sm text-[#4d6358]">Saved plans<select value={savedPlan?.id ?? ''} onChange={event => setSelectedPlanId(event.target.value)} className="mt-1 block w-full rounded-xl border border-[#d4d3c7] bg-white px-3 py-2"><option value="" disabled>Choose a saved plan</option>{savedPlans.data.map(item => <option key={item.id} value={item.id}>Exam {new Date(`${item.examDate}T12:00:00`).toLocaleDateString()} · {item.minutesPerDay} min/day · {new Date(item.savedAt).toLocaleDateString()}</option>)}</select></label>}
    <div className="mt-4 flex flex-wrap items-end gap-4">
      <label className="text-sm text-[#4d6358]">Exam date<input type="date" value={examDate} min={localDayKey()} max={maxExamDate} onChange={e => setExamDate(e.target.value)} className="mt-1 block rounded-xl border border-[#d4d3c7] bg-white px-3 py-2" /></label>
      <label className="text-sm text-[#4d6358]">Minutes per day<input type="number" min={15} max={480} step={5} value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="mt-1 block w-28 rounded-xl border border-[#d4d3c7] bg-white px-3 py-2" /></label>
      <button className={primaryBtn} disabled={plan.isPending || createSavedPlan.isPending || !examDate || minutes < 15 || minutes > 480} onClick={() => void buildPlan()}><RotateCcw size={15} />{plan.isPending || createSavedPlan.isPending ? 'Building…' : savedPlan ? 'Build a new plan' : 'Build my plan'}</button>
    </div>
    {plan.isPending && <div className="mt-3"><Spinner label="Planning a realistic study schedule…" /></div>}
    {plan.isError && <div className="mt-3"><ErrorNote message={(plan.error as Error).message} /></div>}
    {createSavedPlan.isError && <div className="mt-3"><ErrorNote message={(createSavedPlan.error as Error).message} /></div>}
    {updateSavedPlan.isError && <div className="mt-3"><ErrorNote message={(updateSavedPlan.error as Error).message} /></div>}
    {savedPlan && <div className="mt-5">
      <div className="mb-3 rounded-2xl border border-[#dce4d6] bg-gradient-to-r from-[#f0f5eb] to-[#faf6ea] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#718075]">Saved study plan</div><div className="mt-1 font-semibold text-[#25473c]">Exam {new Date(`${savedPlan.examDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · {savedPlan.minutesPerDay} min/day</div></div>
          <div className="text-right"><div className="text-sm font-semibold text-[#25473c]">{completeCount} / {taskCount} tasks done</div><div className="mt-1 h-2 w-36 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-[#63816a] transition-all" style={{ width: `${taskCount ? Math.min(100, completeCount / taskCount * 100) : 0}%` }} /></div></div>
        </div>
      </div>
      <div className="space-y-3">{savedPlan.schedule.map(day => <div key={day.date} className="rounded-xl border border-[#e1ddd2] bg-white p-3">
        <div className="font-mono-ui text-xs text-[#a67d4d]">{new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
        <ul className="mt-2 space-y-1.5">{day.tasks.map((task, index) => {
          const key = `${day.date}:${index}`;
          const done = savedPlan.completed.includes(key);
          return <li key={key}><button type="button" aria-pressed={done} onClick={() => toggleTask(key)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-[#f5f3eb] ${done ? 'text-[#869187] line-through' : 'text-[#4d6358]'}`}>
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${done ? 'border-[#63816a] bg-[#63816a] text-white' : 'border-[#d4d3c7] bg-white text-transparent'}`}><Check size={13} /></span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide no-underline ${task.kind === 'study' ? 'bg-[#e7f1ea] text-[#2f6b4a]' : task.kind === 'review' ? 'bg-[#f6f3e8] text-[#8a6a1f]' : 'bg-[#fbeae6] text-[#9a4d3f]'}`}>{task.kind}</span>
            <span className="min-w-0 flex-1">{task.concept}</span><span className="shrink-0 text-xs text-[#9aa398] no-underline">{task.minutes} min</span>
          </button></li>;
        })}</ul></div>)}</div>
      {savedPlan.savedAt && <p className="mt-3 text-[11px] text-[#899084]">Saved to your account {new Date(savedPlan.savedAt).toLocaleString()} · {savedPlans.data?.length ?? 1} saved plan{(savedPlans.data?.length ?? 1) === 1 ? '' : 's'}</p>}
    </div>}
  </section>;
}

export function Revision({ courseId, onStartQuiz }: { courseId: string; onStartQuiz: () => void }) {
  return <div className="space-y-5"><DailyReviewQueue courseId={courseId} onStartQuiz={onStartQuiz} /><FlashcardDeck courseId={courseId} /><Planner courseId={courseId} /></div>;
}
