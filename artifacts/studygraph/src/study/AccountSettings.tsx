import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Bell, Check, Languages, LoaderCircle, Printer, ShieldAlert, Type, X } from 'lucide-react';
import { accountSettingsKey, xfetch, defaultAccountSettings, useAccountSettings, useSaveAccountSettings, type AccountSettings } from './api';
import { ErrorNote, Spinner, primaryBtn } from './common';

const card = 'rounded-2xl border border-[#dfdcd1] bg-[#fbfaf5] p-5 shadow-[0_10px_30px_rgba(37,71,60,.035)]';
const languages: Array<[AccountSettings['language'], string]> = [
  ['en', 'English'], ['hi', 'Hindi'], ['en-IN', 'English (India)'], ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali'], ['mr', 'Marathi'],
];
function ToggleRow({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-[#e5e1d6] bg-white/70 p-4">
    <span><span className="block text-sm font-semibold text-[#365647]">{title}</span><span className="mt-1 block text-xs leading-5 text-[#788478]">{description}</span></span>
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#365d45]" />
  </label>;
}

export function AccountSettingsPage({ Frame }: { Frame: React.ComponentType<{ children: React.ReactNode }> }) {
  const query = useAccountSettings();
  const save = useSaveAccountSettings();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<AccountSettings>(defaultAccountSettings);
  const [savedNotice, setSavedNotice] = useState(false);
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting' | 'done' | 'error'>('idle');
  const [deleteError, setDeleteError] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  useEffect(() => { if (query.data) setSettings(query.data); }, [query.data]);
  function patch<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setSettings(current => ({ ...current, [key]: value }));
    setSavedNotice(false);
  }
  async function saveSettings() {
    try {
      await save.mutateAsync(settings);
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 2500);
    } catch { /* mutation error shown inline */ }
  }
  async function deleteMyData() {
    setDeleteState('deleting');
    setDeleteError('');
    try {
      await xfetch<{ ok: boolean }>('/account/data', { method: 'DELETE' });
      queryClient.setQueryData(accountSettingsKey, defaultAccountSettings);
      await queryClient.invalidateQueries();
      try {
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
          const key = localStorage.key(index);
          if (key?.startsWith('citexa-xp-v1:') || key?.startsWith('citexa:study-plan:v1:')) localStorage.removeItem(key);
        }
      } catch { /* browser storage may be unavailable; server data deletion still succeeded */ }
      setDeleteState('done');
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Your data could not be deleted.');
      setDeleteState('error');
    }
  }
  async function exportMyData() {
    setExportBusy(true); setExportError('');
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) { setExportError('Allow pop-ups for Citexa to open your readable report.'); setExportBusy(false); return; }
    reportWindow.document.write('<!doctype html><title>Preparing your report</title><p style="font:16px system-ui;margin:40px">Preparing your readable study report…</p>');
    try {
      const accountData = await xfetch<Record<string, unknown>>('/account/export');
      const browserLocalStudyData: Record<string, unknown> = {};
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key || (!key.startsWith('citexa-xp-v1:') && !key.startsWith('citexa:study-plan:v1:'))) continue;
          const value = localStorage.getItem(key);
          if (value !== null) { try { browserLocalStudyData[key] = JSON.parse(value); } catch { browserLocalStudyData[key] = value; } }
        }
      } catch { /* include the server export even if browser storage is blocked */ }
      reportWindow.document.open();
      reportWindow.document.write(readableExportHtml(accountData, browserLocalStudyData));
      reportWindow.document.close();
    } catch (error) {
      reportWindow.close();
      setExportError(error instanceof Error ? error.message : 'Your report could not be prepared.');
    }
    finally { setExportBusy(false); }
  }
  return <Frame><main className="mx-auto max-w-[1000px] px-5 pb-16 pt-8 lg:px-9 lg:pt-10">
    <div className="mb-7 border-b border-[#dedbd0] pb-6"><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#a67d4d]">Your workspace / Preferences</div><h1 className="mt-2 font-editorial text-4xl tracking-[-.04em] sm:text-5xl">Settings</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#718075]">Set your study rhythm and reading preferences. These are saved to your account and follow you between devices.</p></div>
    {query.isLoading && <div className="mb-5"><Spinner label="Loading your settings…" /></div>}
    {query.isError && <div className="mb-5"><ErrorNote message={(query.error as Error).message} /><div className="mt-2 flex gap-3"><button onClick={() => void query.refetch()} className="text-xs font-semibold text-[#365647] underline">Retry settings</button>{/sign in|unauthorized|401/i.test((query.error as Error).message) && <button onClick={() => window.location.assign('/sign-in')} className="text-xs font-semibold text-[#365647] underline">Sign in again</button>}</div></div>}
    <div className="space-y-5">
      <section className={card} aria-labelledby="study-settings-title"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e9eee4] text-[#547060]"><Bell size={18} /></span><div><h2 id="study-settings-title" className="font-editorial text-2xl text-[#25473c]">Study rhythm</h2><p className="mt-1 text-xs text-[#788478]">Set a goal and an optional in-app reminder preference.</p></div></div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold text-[#4d6358]">Daily study goal<select value={settings.dailyGoalMinutes} onChange={event => patch('dailyGoalMinutes', Number(event.target.value))} className="mt-2 block w-full rounded-xl border border-[#d4d3c7] bg-white px-3 py-3 font-normal"><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>60 minutes</option><option value={90}>90 minutes</option><option value={120}>120 minutes</option></select></label>
          <label className="text-sm font-semibold text-[#4d6358]">Reminder time<input type="time" value={settings.reminderTime ?? ''} onChange={event => patch('reminderTime', event.target.value || null)} className="mt-2 block w-full rounded-xl border border-[#d4d3c7] bg-white px-3 py-3 font-normal" /><span className="mt-1 block text-xs font-normal text-[#899084]">Local time on your device.</span></label></div>
        <div className="mt-4"><ToggleRow title="Enable reminder preference" description="Stores your preferred reminder time. Citexa does not send push notifications or background alerts yet." checked={settings.remindersEnabled} onChange={value => patch('remindersEnabled', value)} /></div>
      </section>
      <section className={card} aria-labelledby="language-settings-title"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#f1e8d8] text-[#9b774c]"><Languages size={18} /></span><div><h2 id="language-settings-title" className="font-editorial text-2xl text-[#25473c]">Language</h2><p className="mt-1 text-xs text-[#788478]">Choose the default language preference for your study workspace.</p></div></div>
        <label className="mt-5 block max-w-md text-sm font-semibold text-[#4d6358]">Preferred language<select value={settings.language} onChange={event => patch('language', event.target.value as AccountSettings['language'])} className="mt-2 block w-full rounded-xl border border-[#d4d3c7] bg-white px-3 py-3 font-normal">{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </section>
      <section className={card} aria-labelledby="accessibility-title"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e8ebdf] text-[#5c7963]"><Type size={18} /></span><div><h2 id="accessibility-title" className="font-editorial text-2xl text-[#25473c]">Accessibility</h2><p className="mt-1 text-xs text-[#788478]">Adjust reading comfort across the app.</p></div></div>
        <div className="mt-5 space-y-3"><ToggleRow title="Bigger text" description="Increase the app’s base text size for improved readability." checked={settings.biggerText} onChange={value => patch('biggerText', value)} /><ToggleRow title="Dyslexia-friendly font" description="Use a clearer, more distinct letterform and additional spacing for reading." checked={settings.dyslexiaFont} onChange={value => patch('dyslexiaFont', value)} /><ToggleRow title="High contrast" description="Strengthen foreground, border, and focus contrast throughout the interface." checked={settings.highContrast} onChange={value => patch('highContrast', value)} /></div>
      </section>
      <div className="flex flex-wrap items-center gap-3"><button className={primaryBtn} disabled={save.isPending || query.isLoading} onClick={() => void saveSettings()}>{save.isPending ? <LoaderCircle size={15} className="animate-spin" /> : savedNotice ? <Check size={15} /> : null}{save.isPending ? 'Saving…' : savedNotice ? 'Saved to your account' : 'Save settings'}</button>{save.isError && <span role="alert" className="text-sm text-[#a45e52]">{(save.error as Error).message}</span>}</div>
      <section className={card} aria-labelledby="data-controls-title"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e9e6dc] text-[#547060]"><ArrowDownToLine size={18} /></span><div><h2 id="data-controls-title" className="font-editorial text-2xl text-[#25473c]">Your data</h2><p className="mt-1 text-xs text-[#788478]">Open a readable report, print it, or save it as a PDF. You can also remove your Citexa course data.</p></div></div>
        <div className="mt-5 flex flex-wrap gap-3"><button onClick={() => void exportMyData()} disabled={exportBusy} className="inline-flex items-center gap-2 rounded-full border border-[#d4d3c7] bg-white px-4 py-2.5 text-sm font-semibold text-[#365647] hover:bg-[#f1eee4] disabled:opacity-50">{exportBusy ? <LoaderCircle size={15} className="animate-spin" /> : <Printer size={15} />}{exportBusy ? 'Preparing report…' : 'View / print my study report'}</button><button onClick={() => { setDeleteError(''); setDeleteState('confirm'); }} className="inline-flex items-center gap-2 rounded-full border border-[#d9c3bd] bg-[#fbf3f0] px-4 py-2.5 text-sm font-semibold text-[#854f45] hover:bg-[#f4e5e1]"><ShieldAlert size={15} /> Delete my data</button></div>
        {exportError && <p role="alert" className="mt-3 text-sm text-[#a45e52]">{exportError}</p>}
        {(deleteState === 'confirm' || deleteState === 'deleting') && <div className="mt-5 rounded-xl border border-[#e3c9b9] bg-[#fbf1ea] p-4"><h3 className="font-semibold text-[#7a4a36]">Delete all Citexa data for this account?</h3><p className="mt-2 text-sm leading-6 text-[#7a4a36]">This permanently removes your courses, uploaded sources and study material, saved plans, conversations, quiz history, learning progress, and settings. Save or print your report first if you want a copy. This cannot be undone.</p><div className="mt-4 flex flex-wrap gap-2"><button onClick={() => void deleteMyData()} className="inline-flex items-center gap-2 rounded-full bg-[#9a5147] px-4 py-2.5 text-sm font-semibold text-white" disabled={deleteState === 'deleting'}>{deleteState === 'deleting' ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldAlert size={15} />}{deleteState === 'deleting' ? 'Deleting…' : 'Permanently delete my data'}</button><button onClick={() => setDeleteState('idle')} disabled={deleteState === 'deleting'} className="inline-flex items-center gap-2 rounded-full border border-[#d4d3c7] bg-white px-4 py-2.5 text-sm font-semibold text-[#365647] disabled:opacity-50"><X size={15} /> Cancel</button></div></div>}
        {deleteState === 'done' && <p role="status" className="mt-4 rounded-xl bg-[#e9eee4] p-4 text-sm text-[#365647]">Your Citexa course and learning data has been deleted. Your signed-in account remains active.</p>}
    {(deleteState === 'error' || deleteError) && <div className="mt-4"><ErrorNote message={deleteError} /></div>}
      </section>
    </div>
  </main></Frame>;
}

type ReportRow = Record<string, unknown>;
function reportRows(value: unknown): ReportRow[] {
  return Array.isArray(value) ? value.filter((item): item is ReportRow => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
}
function reportObject(value: unknown): ReportRow {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ReportRow : {};
}
function reportText(row: ReportRow, key: string): string {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function reportEscape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
function readableExportHtml(data: ReportRow, browserData: ReportRow): string {
  const courses = reportRows(data.courses);
  const sources = reportRows(data.sources);
  const units = reportRows(data.studyUnits);
  const plans = reportRows(data.savedStudyPlans);
  const conversations = reportRows(data.conversations);
  const messages = reportRows(data.conversationMessages);
  const quizzes = reportRows(data.quizzes);
  const questions = reportRows(data.quizQuestions);
  const attempts = reportRows(data.quizAttempts);
  const assessments = reportRows(data.assessments);
  const assessmentAttempts = reportRows(data.assessmentAttempts);
  const concepts = reportRows(data.concepts);
  const mastery = reportRows(data.learnerMastery);
  const events = reportRows(data.learningEvents);
  const misconceptions = reportRows(data.misconceptions);
  const ideas = new Map(concepts.map(item => [reportText(item, 'id'), reportText(item, 'name')]));
  const section = (title: string, content: string) => `<section><h2>${reportEscape(title)}</h2>${content || '<p class="empty">Nothing saved here yet.</p>'}</section>`;
  const settings = reportObject(data.settings);
  const settingsHtml = `<dl>${[['Daily study goal', `${reportText(settings, 'dailyGoalMinutes') || '—'} minutes`], ['Language', reportText(settings, 'language') || 'English'], ['Reminder', settings.remindersEnabled ? reportText(settings, 'reminderTime') || 'On' : 'Off'], ['Larger text', settings.biggerText ? 'On' : 'Off'], ['Dyslexia-friendly font', settings.dyslexiaFont ? 'On' : 'Off'], ['High contrast', settings.highContrast ? 'On' : 'Off']].map(([label, value]) => `<div><dt>${reportEscape(label)}</dt><dd>${reportEscape(value)}</dd></div>`).join('')}</dl>`;
  const courseHtml = courses.map(course => {
    const id = reportText(course, 'id');
    const courseSources = sources.filter(source => reportText(source, 'courseId') === id);
    const sourceHtml = courseSources.map(source => {
      const sourceUnits = units.filter(unit => reportText(unit, 'sourceId') === reportText(source, 'id'));
      const notes = sourceUnits.map(unit => {
        const locator = reportObject(unit.locator);
        const where = locator.type === 'page' ? `Page ${reportText(locator, 'page')}` : locator.type === 'slide' ? `Slide ${reportText(locator, 'slide')}` : 'Course material';
        const caption = reportText(unit, 'figureCaption');
        return `<article class="note"><small>${reportEscape(where)}</small><p>${reportEscape(reportText(unit, 'text'))}</p>${caption ? `<p><b>Image or diagram:</b> ${reportEscape(caption)}</p>` : ''}</article>`;
      }).join('');
      return `<h4>${reportEscape(reportText(source, 'title') || reportText(source, 'originalFilename') || 'Course file')}</h4><p class="muted">${reportEscape(reportText(source, 'status') || 'Saved')} · ${sourceUnits.length} study notes</p>${notes || '<p class="muted">No extracted notes.</p>'}`;
    }).join('');
    return `<article class="card"><h3>${reportEscape(reportText(course, 'name') || 'Course')}</h3>${reportText(course, 'description') ? `<p>${reportEscape(reportText(course, 'description'))}</p>` : ''}<p class="muted">${courseSources.length} course files · ${courseSources.filter(source => reportText(source, 'status') === 'ready').length} ready</p>${sourceHtml || '<p class="empty">No course files saved.</p>'}</article>`;
  }).join('');
  const planHtml = plans.map(plan => {
    const completed = new Set(Array.isArray(plan.completed) ? plan.completed.filter((item): item is string => typeof item === 'string') : []);
    const days = reportRows(plan.schedule).map(day => {
      const date = reportText(day, 'date');
      const dayTasks = Array.isArray(day.tasks) ? day.tasks : [];
      return `<h4>${reportEscape(date)}</h4><ul>${dayTasks.map((task, index) => { const row = reportObject(task); return `<li>${completed.has(`${date}:${index}`) ? 'Done' : 'To do'} · ${reportEscape(reportText(row, 'concept'))} · ${reportEscape(reportText(row, 'minutes'))} min</li>`; }).join('')}</ul>`;
    }).join('');
    return `<article class="card"><h3>Exam ${reportEscape(reportText(plan, 'examDate'))}</h3><p>${reportEscape(reportText(plan, 'minutesPerDay'))} minutes per day</p>${days}</article>`;
  }).join('');
  const chatHtml = conversations.map(chat => {
    const chatMessages = messages.filter(message => reportText(message, 'conversationId') === reportText(chat, 'id'));
    return `<article class="card"><h3>${reportEscape(reportText(chat, 'title') || 'Study chat')}</h3>${chatMessages.map(message => `<div class="message"><b>${reportText(message, 'role') === 'user' ? 'You' : 'Citexa'} · ${reportEscape(new Date(reportText(message, 'createdAt')).toLocaleString())}</b><p>${reportEscape(reportText(message, 'content').replace(/<!--[^>]*-->/g, '').replace(/\n\n\(Please answer in [\s\S]*\)\s*$/, ''))}</p></div>`).join('') || '<p class="muted">No saved messages.</p>'}</article>`;
  }).join('');
  const quizHtml = quizzes.map(quiz => {
    const id = reportText(quiz, 'id');
    const quizQuestions = questions.filter(question => reportText(question, 'quizId') === id);
    const quizAttempts = attempts.filter(attempt => reportText(attempt, 'quizId') === id);
    const questionsHtml = quizQuestions.map(question => {
      const options = Array.isArray(question.options) ? question.options.map(String) : [];
      const answer = reportObject(question.answerKey);
      const correct = answer.type === 'mcq' && Number.isInteger(answer.correctOption) ? options[Number(answer.correctOption)] : reportText(answer, 'modelAnswer') || reportText(answer, 'value');
      return `<article class="note"><h4>${reportEscape(reportText(question, 'prompt'))}</h4>${options.length ? `<p><b>Choices:</b> ${options.map(reportEscape).join(' · ')}</p>` : ''}${correct ? `<p><b>Answer:</b> ${reportEscape(correct)}</p>` : ''}${reportText(question, 'explanation') ? `<p>${reportEscape(reportText(question, 'explanation'))}</p>` : ''}</article>`;
    }).join('');
    const results = quizAttempts.map(attempt => `<p class="muted">Result: ${reportEscape(reportText(attempt, 'score'))} out of ${reportEscape(reportText(attempt, 'total'))}</p>`).join('');
    return `<article class="card"><h3>${reportEscape(reportText(quiz, 'title') || 'Practice quiz')}</h3>${results}${questionsHtml}</article>`;
  }).join('');
  const assessmentHtml = assessments.map(assessment => {
    const results = assessmentAttempts.filter(attempt => reportText(attempt, 'assessmentId') === reportText(assessment, 'id'));
    return `<article class="card"><h3>${reportEscape(reportText(assessment, 'title') || 'Assessment')}</h3>${results.map(attempt => `<p class="muted">Result: ${reportEscape(reportText(attempt, 'score'))} out of ${reportEscape(reportText(attempt, 'total'))} · ${reportEscape(new Date(reportText(attempt, 'createdAt')).toLocaleDateString())}</p>`).join('') || '<p class="muted">No completed attempts saved.</p>'}</article>`;
  }).join('');
  const progressHtml = mastery.map(item => `<li><b>${reportEscape(ideas.get(reportText(item, 'conceptId')) || 'Course idea')}</b> · ${Math.round(Number(item.pKnown ?? item.mastery ?? 0) * 100)}% understood · ${reportEscape(reportText(item, 'attempts') || '0')} practice attempts</li>`).join('') + events.map(item => `<li>${reportEscape(reportText(item, 'eventType') || reportText(item, 'kind') || 'Study activity')} · ${reportEscape(ideas.get(reportText(item, 'conceptId')) || 'Course idea')} · ${reportEscape(new Date(reportText(item, 'createdAt')).toLocaleDateString())}</li>`).join('');
  const reviewHtml = misconceptions.map(item => `<li>${reportEscape(reportText(item, 'misconception') || reportText(item, 'label') || 'Review point')} · noted ${reportEscape(reportText(item, 'count') || 'once')}</li>`).join('');
  const deviceHtml = Object.entries(browserData).map(([key, value]) => {
    const item = reportObject(value);
    if (key.startsWith('citexa-xp-v1:')) return `<article class="card"><h3>Daily study progress</h3><p>${reportEscape(reportText(item, 'xp') || '0')} points · ${reportEscape(reportText(item, 'streak') || '0')} day streak · ${reportEscape(reportText(item, 'minutesToday') || '0')} minutes today · goal ${reportEscape(reportText(item, 'goalMinutes') || '30')} minutes</p></article>`;
    if (key.startsWith('citexa:study-plan:v1:')) return `<article class="card"><h3>Schedule saved on this device</h3><p>Exam ${reportEscape(reportText(item, 'examDate'))} · ${reportEscape(reportText(item, 'minutesPerDay'))} minutes per day</p></article>`;
    return '';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Citexa study report</title><style>body{font:15px/1.6 system-ui,sans-serif;color:#25473c;background:#f5f3eb;margin:0}.page{max-width:900px;margin:30px auto;padding:28px;background:#fffef9;border:1px solid #dedbd0;border-radius:20px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #dedbd0;padding-bottom:18px}h1{font-size:30px}h2{margin-top:30px;border-bottom:1px solid #e5e1d6;padding-bottom:6px;font-size:22px}h3{margin:6px 0}.muted,small{color:#798579;font-size:13px}.card{border:1px solid #e4e0d5;border-radius:12px;padding:16px;margin:12px 0;break-inside:avoid}.note{border-left:3px solid #d9d3c3;padding:6px 12px;margin:8px 0;white-space:pre-wrap}.message{padding:8px 0;border-bottom:1px solid #eee}.message p{white-space:pre-wrap}.empty{background:#f4f1e8;padding:12px;border-radius:10px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}dl div{background:#f4f2ea;padding:10px;border-radius:8px}dt{font-size:12px;color:#728074}dd{margin:2px 0 0;font-weight:600}.print{background:#25473c;color:white;border:0;border-radius:24px;padding:12px 18px;font-weight:700;cursor:pointer}@media print{body{background:white}.page{margin:0 auto;max-width:none;border:0;border-radius:0;padding:0}.print{display:none}}</style></head><body><main class="page"><header><div><h1>Your Citexa study report</h1><p class="muted">A readable copy of the information saved in your account.</p><p class="muted">Prepared ${reportEscape(new Date().toLocaleString())}. Uploaded original files are not included.</p></div><button class="print" onclick="window.print()">Print / Save as PDF</button></header>${section('Your settings', settingsHtml)}${section('Your courses and notes', courseHtml)}${section('Saved study schedules', planHtml)}${section('Study chats', chatHtml)}${section('Quizzes and answers', quizHtml)}${section('Assessments and results', assessmentHtml)}${section('Your learning progress', `<ul>${progressHtml}</ul>`)}${section('Topics to review', `<ul>${reviewHtml}</ul>`)}${section('Progress saved on this device', deviceHtml)}<p class="muted">Keep this report somewhere private because it contains your study information.</p></main></body></html>`;
}
