import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpenCheck, Check, ChevronDown, FileDown, Flame, GraduationCap, LoaderCircle, Printer, Search, Sparkles, Target, Trophy } from 'lucide-react';
import { getListSourcesQueryKey, useListSources } from '@workspace/api-client-react';
import { defaultAccountSettings, useAccountSettings, useSaveAccountSettings, xfetch } from './api';
import { useMastery } from './api';
import { CitationChips, ErrorNote, Spinner, card, primaryBtn } from './common';
import type { Citation } from './types';

type CitedText = { text: string; citations: Citation[] };
type CheatSheet = { topics: Array<{ id: string; topic: string; definitions: CitedText[]; formulas: CitedText[]; examples: CitedText[] }>; note: string; fallback?: boolean; omittedTopicCount?: number };
type Glossary = { terms: Array<{ id: string; term: string; topic: string; meaning: string; citations: Citation[] }>; note: string };
type Prediction = { topics: Array<{ id: string; topic: string; coverageScore: number; importance: string; signal: string; paperCount: number; conceptCount: number; mentionCount: number; citations: Citation[] }>; selectedSources: Array<{ id: string; title: string }>; totalSelectedPapers: number; disclaimer: string };
type XPState = { xp: number; goalMinutes: number; minutesToday: number; date: string; streak: number; lastActive: string; goalBonusDate: string; creditedMilestones: string[] };
const emptyXP = (): XPState => ({ xp: 0, goalMinutes: 30, minutesToday: 0, date: '', streak: 0, lastActive: '', goalBonusDate: '', creditedMilestones: [] });
const xpKey = (courseId: string) => `citexa-xp-v1:${courseId}`;
const cardBase = 'rounded-2xl border border-[#dfdcd1] bg-[#fbfaf5] p-5 shadow-[0_10px_30px_rgba(37,71,60,.035)]';
const button = 'inline-flex items-center justify-center gap-2 rounded-full border border-[#d4d3c7] bg-white px-4 py-2.5 text-sm font-semibold text-[#365647] transition hover:-translate-y-0.5 hover:border-[#8fa18f] disabled:cursor-not-allowed disabled:opacity-50';

function todayKey() { return new Date().toLocaleDateString('en-CA'); }
function loadXP(courseId: string): XPState {
  try {
    const value = JSON.parse(localStorage.getItem(xpKey(courseId)) || 'null') as Partial<XPState> | null;
    return { ...emptyXP(), ...(value ?? {}) };
  } catch { return emptyXP(); }
}
function locatorText(citation: Citation) {
  const locator = citation.locator;
  if (locator.type === 'page') return `p. ${locator.page}`;
  if (locator.type === 'slide') return `slide ${locator.slide}`;
  const sec = Math.max(0, Math.floor(locator.start_sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function ExamTools({ courseId }: { courseId: string }) {
  const [view, setView] = useState<'cheat-sheet' | 'glossary' | 'predictor' | 'goals'>('cheat-sheet');
  const [sheet, setSheet] = useState<CheatSheet | null>(null);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [search, setSearch] = useState('');
  const accountSettings = useAccountSettings();
  const mastery = useMastery(courseId);
  const saveSettings = useSaveAccountSettings();
  const sourcesQuery = useListSources({ courseId }, { query: { queryKey: getListSourcesQueryKey({ courseId }), staleTime: 15_000 }, request: { credentials: 'same-origin' } });
  const glossary = useQuery({ queryKey: ['study-glossary', courseId], queryFn: () => xfetch<Glossary>(`/x/courses/${courseId}/glossary`), staleTime: 60_000, enabled: view === 'glossary' });
  const makeSheet = useMutation({ mutationFn: () => xfetch<CheatSheet>(`/x/courses/${courseId}/cheat-sheet`, { method: 'POST', body: JSON.stringify({}) }), onSuccess: setSheet });
  const predict = useMutation({ mutationFn: (sourceIds: string[]) => xfetch<Prediction>(`/x/courses/${courseId}/past-paper-predictor`, { method: 'POST', body: JSON.stringify({ sourceIds }) }), onSuccess: setPrediction });
  const [xp, setXP] = useState<XPState>(() => loadXP(courseId));
  useEffect(() => {
    const goal = accountSettings.data?.dailyGoalMinutes;
    if (!goal || xp.goalMinutes === goal) return;
    const next = { ...xp, goalMinutes: goal };
    setXP(next);
    try { localStorage.setItem(xpKey(courseId), JSON.stringify(next)); } catch { /* account preference stays saved */ }
  }, [accountSettings.data?.dailyGoalMinutes, courseId, xp]);
  const availablePapers = (sourcesQuery.data ?? []).filter(source => source.status === 'ready' && source.sourceType !== 'video');
  const filteredTerms = useMemo(() => (glossary.data?.terms ?? []).filter(item => `${item.term} ${item.meaning} ${item.topic}`.toLowerCase().includes(search.toLowerCase())), [glossary.data, search]);
  const level = Math.floor(xp.xp / 100) + 1;
  const today = todayKey();
  const todayMilestones = (mastery.data?.studyMilestones ?? []).filter(item => new Date(item.at).toLocaleDateString('en-CA') === today);
  const autoMinutesToday = todayMilestones.reduce((total, item) => total + item.minutes, 0);
  const minutesToday = (xp.date === today ? xp.minutesToday : 0) + autoMinutesToday;
  const progress = Math.min(100, Math.round((minutesToday / Math.max(1, xp.goalMinutes)) * 100));

  useEffect(() => {
    if (!todayMilestones.length) return;
    setXP(current => {
      const credited = new Set(current.creditedMilestones ?? []);
      const fresh = todayMilestones.filter(item => !credited.has(item.id));
      if (!fresh.length) return current;
      for (const item of fresh) credited.add(item.id);
      const previous = new Date(); previous.setDate(previous.getDate() - 1);
      const yesterday = previous.toLocaleDateString('en-CA');
      const sameDay = current.date === today;
      const nextStreak = sameDay || current.lastActive === today ? current.streak : current.lastActive === yesterday ? current.streak + 1 : 1;
      let earned = fresh.reduce((sum, item) => sum + item.minutes, 0);
      let bonusDate = current.goalBonusDate;
      const manualMinutes = sameDay ? current.minutesToday : 0;
      const newAutomaticMinutes = todayMilestones.reduce((sum, item) => sum + item.minutes, 0);
      if (manualMinutes + newAutomaticMinutes >= current.goalMinutes && bonusDate !== today) {
        earned += 25;
        bonusDate = today;
      }
      const next: XPState = {
        ...current,
        xp: current.xp + earned,
        date: today,
        streak: nextStreak,
        lastActive: today,
        goalBonusDate: bonusDate,
        creditedMilestones: [...credited],
      };
      try { localStorage.setItem(xpKey(courseId), JSON.stringify(next)); } catch { /* automatic progress remains visible in this session */ }
      return next;
    });
  }, [courseId, today, mastery.data?.studyMilestones]);

  function setGoal(minutes: number) {
    const account = accountSettings.data ?? defaultAccountSettings;
    const next = { ...xp, goalMinutes: minutes };
    setXP(next); localStorage.setItem(xpKey(courseId), JSON.stringify(next));
    saveSettings.mutate({ ...account, dailyGoalMinutes: minutes });
  }
  function logStudy(minutes: number) {
    const sameDay = xp.date === today;
    const previous = new Date(); previous.setDate(previous.getDate() - 1);
    const yesterday = previous.toLocaleDateString('en-CA');
    const nextMinutes = (sameDay ? xp.minutesToday : 0) + autoMinutesToday + minutes;
    const nextStreak = sameDay ? xp.streak : xp.lastActive === yesterday ? xp.streak + 1 : 1;
    let earned = Math.max(5, minutes);
    let bonusDate = xp.goalBonusDate;
    if (nextMinutes >= xp.goalMinutes && bonusDate !== today) { earned += 25; bonusDate = today; }
    const next: XPState = { ...xp, xp: xp.xp + earned, goalMinutes: xp.goalMinutes, minutesToday: (sameDay ? xp.minutesToday : 0) + minutes, date: today, streak: nextStreak, lastActive: today, goalBonusDate: bonusDate, creditedMilestones: xp.creditedMilestones ?? [] };
    setXP(next); localStorage.setItem(xpKey(courseId), JSON.stringify(next));
  }

  return <section className="space-y-5">
    <header className="flex flex-col gap-4 rounded-3xl border border-[#dedbd0] bg-gradient-to-br from-[#f8f6ed] via-[#f5f3eb] to-[#e9eee4] p-6 sm:flex-row sm:items-end sm:justify-between">
      <div><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#a67d4d]">Exam Lab · grounded in your sources</div><h2 className="mt-2 font-editorial text-3xl text-[#25473c] sm:text-4xl">Turn your course into a plan.</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#718075]">Build cited revision pages, learn course terms, and use past papers to find where to focus next.</p></div>
      <div className="flex items-center gap-2 rounded-2xl border border-white/70 bg-white/75 px-4 py-3 text-sm text-[#365647]"><Trophy size={17} className="text-[#a67d4d]" /><span><b>Level {level}</b><span className="ml-2 text-[#7b867c]">{xp.xp} XP</span></span></div>
    </header>

    <nav aria-label="Exam Lab tools" className="flex gap-2 overflow-x-auto pb-1">
      {([
        ['cheat-sheet', 'Cheat sheets', FileDown], ['glossary', 'Glossary', BookOpenCheck], ['predictor', 'Past-paper predictor', Sparkles], ['goals', 'Daily goals', Target],
      ] as const).map(([id, label, Icon]) => <button key={id} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined} className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition ${view === id ? 'bg-[#25473c] text-[#f7f3e8] shadow-md shadow-[#25473c]/10' : 'border border-[#dedbd0] bg-white/70 text-[#617267] hover:bg-white'}`}><Icon size={15} />{label}</button>)}
    </nav>

    {view === 'cheat-sheet' && <div className="space-y-4">
      <div className={`${cardBase} exam-tools-controls flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`}><div><h3 className="font-editorial text-2xl text-[#25473c]">One page per topic</h3><p className="mt-1 text-sm text-[#718075]">Only source-supported definitions, formulas, and examples are included. Each item links back to its evidence.</p></div><div className="flex gap-2"><button className={button} disabled={!sheet?.topics.length} onClick={() => window.print()}><Printer size={15} /> Print / Save PDF</button><button className={primaryBtn} disabled={makeSheet.isPending} onClick={() => makeSheet.mutate()}>{makeSheet.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}{makeSheet.isPending ? 'Building…' : sheet ? 'Refresh sheets' : 'Build cheat sheets'}</button></div></div>
      {makeSheet.isError && <ErrorNote message={(makeSheet.error as Error).message} />}
      {makeSheet.isPending && <Spinner label="Finding definitions, formulas, examples, and their source locations…" />}
      {sheet && <div id="citexa-print-sheet" className="space-y-5">
        {!!sheet.omittedTopicCount && <p className="exam-tools-controls rounded-xl border border-[#e4d4ad] bg-[#fbf5e6] p-3 text-sm text-[#756137]">This batch contains 16 topics; {sheet.omittedTopicCount} additional course topic(s) were not included. Use the Course map to review those topics.</p>}
        {sheet.topics.map(topic => <article key={topic.id} className="exam-sheet-page rounded-2xl border border-[#ddd9cc] bg-[#fffef9] p-6 shadow-[0_10px_35px_rgba(37,71,60,.045)] sm:p-8">
          <div className="mb-5 border-b border-[#e6e1d5] pb-4"><div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#a67d4d]">Citexa · Exam revision sheet</div><h3 className="mt-1 font-editorial text-3xl text-[#25473c]">{topic.topic}</h3></div>
          {([ [sheet.fallback ? 'Source notes' : 'Key definitions', topic.definitions], ['Formulas', topic.formulas], ['Examples', topic.examples] ] as const).map(([label, entries]) => entries.length > 0 && <section key={label} className="mb-5 last:mb-0"><h4 className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#65806c]">{label}</h4><div className="space-y-3">{entries.map((entry, index) => <div key={`${label}-${index}`} className="rounded-xl bg-[#f5f3eb] px-4 py-3"><p className="whitespace-pre-wrap text-sm leading-6 text-[#2d4439]">{entry.text}</p><div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[#7a806f]"><span>Evidence</span>{entry.citations.map((cite, citeIndex) => <span key={cite.unitId} className="rounded-full border border-[#d8d4c8] bg-white px-2 py-1">{cite.sourceTitle} · {locatorText(cite)}{citeIndex < entry.citations.length - 1 ? '' : ''}</span>)}</div><div className="exam-screen-citations mt-2"><CitationChips citations={entry.citations} /></div></div>)}</div></section>)}
        </article>)}
      </div>}
      {sheet?.note && <p className="exam-tools-controls text-xs text-[#788478]">{sheet.note}</p>}
      {!sheet && !makeSheet.isPending && <div className="rounded-2xl border border-dashed border-[#d1cbbd] bg-[#fbfaf5]/70 p-10 text-center"><FileDown className="mx-auto text-[#829383]" size={26} /><p className="mt-3 font-editorial text-xl text-[#365647]">Your revision pages will appear here.</p><p className="mt-1 text-sm text-[#879084]">Build them from sources that have finished processing.</p></div>}
    </div>}

    {view === 'glossary' && <div className="space-y-4">
      <div className={`${cardBase} flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between`}><div><h3 className="font-editorial text-2xl text-[#25473c]">Course glossary</h3><p className="mt-1 text-sm text-[#718075]">Plain-language meanings are grounded in extracted concepts and linked to their source locations.</p></div><label className="relative block w-full sm:max-w-xs"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#899084]" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a term…" className="w-full rounded-full border border-[#d8d5c9] bg-white py-2.5 pl-9 pr-4 text-sm outline-none focus:border-[#829783]" /></label></div>
      {glossary.isLoading && <Spinner label="Building your source-grounded glossary…" />}{glossary.isError && <ErrorNote message={(glossary.error as Error).message} />}
      {glossary.data && <><p className="text-xs text-[#899084]">{glossary.data.terms.length} terms · meanings are simplified from course sources, not outside references.</p><div className="grid gap-3 md:grid-cols-2">{filteredTerms.map(item => <article key={item.id} className={`${cardBase} transition hover:-translate-y-0.5 hover:shadow-lg`}><div className="flex items-start justify-between gap-3"><div><div className="font-mono-ui text-[9px] uppercase tracking-[.13em] text-[#a67d4d]">{item.topic}</div><h4 className="mt-1 font-editorial text-xl text-[#25473c]">{item.term}</h4></div><ChevronDown size={15} className="mt-1 shrink-0 text-[#9b9b8b]" /></div><p className="mt-3 text-sm leading-6 text-[#566d5d]">{item.meaning}</p><div className="mt-4"><CitationChips citations={item.citations} /></div></article>)}</div>{!filteredTerms.length && <div className="rounded-xl bg-[#f1eee4] p-5 text-sm text-[#718075]">No glossary terms match this search.</div>}</>}
    </div>}

    {view === 'predictor' && <div className="space-y-4">
      <div className={cardBase}><div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f2e9dd] text-[#a77947]"><Sparkles size={18} /></div><div><h3 className="font-editorial text-2xl text-[#25473c]">Past-paper priority guide</h3><p className="mt-1 max-w-3xl text-sm leading-6 text-[#718075]">Add past papers to this course, wait until they are Ready, and select them here. Citexa ranks the course topics that recur across papers most often, with more linked passages and concepts strengthening their priority. Use the citations to check the evidence; no tool can guarantee the exact questions on a future exam.</p></div></div>
        {sourcesQuery.isError && <div className="mt-4"><ErrorNote message={(sourcesQuery.error as Error).message} /></div>}
        {sourcesQuery.isLoading ? <div className="mt-4"><Spinner label="Loading course sources…" /></div> : !availablePapers.length ? <p className="mt-4 rounded-xl bg-[#f1eee4] p-4 text-sm text-[#718075]">No ready PDF or slide sources found. Upload past papers (PDF/PPTX) in the Source library first.</p> : <div className="mt-5 grid gap-2 sm:grid-cols-2">{availablePapers.map(source => <label key={source.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${selectedSources.includes(source.id) ? 'border-[#7d9a7e] bg-[#edf4e9]' : 'border-[#e3dfd3] bg-white/70 hover:bg-white'}`}><input type="checkbox" checked={selectedSources.includes(source.id)} onChange={e => setSelectedSources(current => e.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} className="mt-1 accent-[#365d45]" /><span className="min-w-0"><span className="block truncate text-sm font-semibold text-[#365647]">{source.title}</span><span className="mt-0.5 block text-xs text-[#899084]">{source.sourceType.toUpperCase()} · Ready</span></span></label>)}</div>}
        <div className="mt-4 flex flex-wrap items-center gap-3"><button className={primaryBtn} disabled={!selectedSources.length || predict.isPending} onClick={() => predict.mutate(selectedSources)}>{predict.isPending && <LoaderCircle size={15} className="animate-spin" />}{predict.isPending ? 'Comparing topics…' : 'Rank covered topics'}</button><span className="text-xs text-[#899084]">Selected papers are only analyzed for this course.</span></div>
        {predict.isError && <div className="mt-3"><ErrorNote message={(predict.error as Error).message} /></div>}
      </div>
      {prediction && <div className="space-y-3"><div className="rounded-xl border border-[#ddcda8] bg-[#fbf5e6] p-4 text-sm leading-6 text-[#756137]">Reviewed {prediction.totalSelectedPapers} selected paper(s). {prediction.disclaimer}</div>{prediction.topics.map((topic, index) => <article key={topic.id} className={cardBase}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#e9eee4] font-mono-ui text-xs font-bold text-[#49684f]">{index + 1}</span><div><span className={`mb-1 inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold ${topic.importance === 'High priority' ? 'bg-[#e5eee4] text-[#3f6848]' : topic.importance === 'Worth reviewing' ? 'bg-[#f4ecd9] text-[#806b42]' : 'bg-[#efede4] text-[#69766c]'}`}>{topic.importance}</span><h4 className="font-editorial text-xl text-[#25473c]">{topic.topic}</h4><p className="text-xs text-[#899084]">{topic.signal}</p></div></div><div className="min-w-[140px]"><div className="flex justify-between text-[10px] text-[#758075]"><span>Priority evidence</span><span>{topic.coverageScore}/100</span></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-[#e9e6dc]"><div className="h-full rounded-full bg-gradient-to-r from-[#8fa77f] to-[#365d45]" style={{ width: `${topic.coverageScore}%` }} /></div></div></div><div className="mt-3"><CitationChips citations={topic.citations} /></div></article>)}{!prediction.topics.length && <div className="rounded-xl bg-[#f1eee4] p-5 text-sm text-[#718075]">No selected past-paper units matched an extracted course topic yet. Check processing and course topic links.</div>}</div>}
    </div>}

    {view === 'goals' && <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(260px,.9fr)]">
      <section className={`${cardBase} overflow-hidden`}><div className="flex items-start justify-between gap-4"><div><div className="font-mono-ui text-[9px] uppercase tracking-[.15em] text-[#a67d4d]">Today’s rhythm</div><h3 className="mt-1 font-editorial text-2xl text-[#25473c]">A small daily win compounds.</h3><p className="mt-1 text-sm text-[#718075]">Your progress updates as you master concepts and complete topics. You can also log a focused study block.</p></div><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#fff0d6] text-[#9c702d]"><Flame size={22} /></div></div>
        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Daily study goal">{[15, 30, 45, 60, 90, 120].map(minutes => <button key={minutes} disabled={saveSettings.isPending} onClick={() => setGoal(minutes)} aria-pressed={xp.goalMinutes === minutes} className={`rounded-full px-4 py-2 text-sm font-semibold transition ${xp.goalMinutes === minutes ? 'bg-[#25473c] text-white' : 'border border-[#ddd9ce] bg-white text-[#617267] hover:bg-[#f1eee4]'}`}>{minutes} min</button>)}</div>
        <div className="mt-6 rounded-2xl bg-[#f1eee4] p-4"><div className="flex items-center justify-between text-sm"><span className="font-semibold text-[#365647]">{minutesToday} of {xp.goalMinutes} minutes</span><span className="text-[#718075]">{progress}%</span></div><div className="mt-2 h-3 overflow-hidden rounded-full bg-[#dedbd0]"><div className="h-full rounded-full bg-gradient-to-r from-[#8ba47b] via-[#66886d] to-[#25473c] transition-[width] duration-700" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-xs text-[#899084]">{progress >= 100 ? 'Daily goal reached. Nice work.' : `${Math.max(0, xp.goalMinutes - minutesToday)} minutes left to hit today’s goal.`}</p></div>
        <button onClick={() => logStudy(10)} className={`${primaryBtn} mt-5`}><Check size={15} /> Log 10 focused minutes · +10 XP</button>
        <p className="mt-3 text-xs text-[#899084]">When your goal is reached, you earn a one-time +25 XP bonus for today.</p>
      </section>
      <aside className={`${cardBase} flex flex-col justify-between bg-gradient-to-br from-[#25473c] to-[#3d6652] text-[#f7f3e8]`}><div><div className="flex items-center gap-2 text-xs uppercase tracking-[.15em] text-[#d9c79f]"><Trophy size={15} /> Your study journey</div><div className="mt-6 font-editorial text-5xl">Level {level}</div><p className="mt-2 text-sm text-[#d9e2d7]">{xp.xp} XP collected · {xp.streak} day{xp.streak === 1 ? '' : 's'} active streak</p><div className="mt-5 h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-[#d9c79f] transition-[width] duration-700" style={{ width: `${xp.xp % 100}%` }} /></div><p className="mt-2 text-xs text-[#d9e2d7]">{100 - (xp.xp % 100)} XP to the next level</p></div></aside>
    </div>}
  </section>;
}
