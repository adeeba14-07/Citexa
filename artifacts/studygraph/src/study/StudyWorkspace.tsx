import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, LayoutDashboard, BookMarked, ClipboardList, MessageSquareText, Network, Sparkles } from 'lucide-react';
import { useListCourses, getListCoursesQueryKey } from '@workspace/api-client-react';
import { ViewerProvider } from './common';
import { TutorChat } from './TutorChat';
import { QuizPanel } from './QuizPanel';
import { Dashboard } from './Dashboard';
import { KnowledgeMap } from './KnowledgeMap';
import { Revision } from './Revision';
import { ExamTools } from './ExamTools';

const TABS = [
  { id: 'tutor', label: 'Tutor', icon: MessageSquareText },
  { id: 'quiz', label: 'Quizzes', icon: ClipboardList },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'map', label: 'Course map', icon: Network },
  { id: 'revise', label: 'Revision', icon: BookMarked },
  { id: 'exam-lab', label: 'Exam Lab', icon: Sparkles },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function StudyWorkspace({ courseId, tab, Frame }: { courseId: string; tab?: string; Frame: React.ComponentType<{ children: React.ReactNode }> }) {
  const [, navigate] = useLocation();
  const active: TabId = TABS.some(t => t.id === tab) ? (tab as TabId) : 'tutor';
  const [practiceTopic, setPracticeTopic] = useState<string | undefined>();
  const courses = useListCourses({ query: { queryKey: getListCoursesQueryKey() }, request: { credentials: 'same-origin' } });
  const title = courses.data?.find(c => c.id === courseId)?.name ?? 'Course';
  const go = (id: TabId) => navigate(`/courses/${courseId}/study/${id}`);

  return <Frame>
    <ViewerProvider>
      <main className="mx-auto max-w-[1100px] px-5 pb-20 pt-8 lg:px-9">
        <Link href={`/courses/${courseId}`} className="inline-flex items-center gap-2 text-xs text-[#788478] hover:text-[#25473c]"><ArrowLeft size={14} /> Source library</Link>
        <div className="mt-4 border-b border-[#dedbd0] pb-5"><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#a67d4d]">Study workspace</div>
          <h1 className="mt-1 truncate font-editorial text-4xl tracking-[-.03em] text-[#25473c] sm:text-5xl">{title}</h1></div>
        <nav aria-label="Study sections" className="sticky top-0 z-10 -mx-1 mt-4 flex gap-1 overflow-x-auto bg-[#f5f3eb]/90 px-1 py-2 backdrop-blur">
          {TABS.map(t => { const Icon = t.icon; return <button key={t.id} onClick={() => go(t.id)} aria-current={active === t.id ? 'page' : undefined}
            className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${active === t.id ? 'bg-[#25473c] text-[#f7f3e8]' : 'text-[#5d7065] hover:bg-[#ebe8dc]'}`}><Icon size={15} />{t.label}</button>; })}
        </nav>
        <div key={active} className="cx-panel mt-5">
          {active === 'tutor' && <TutorChat courseId={courseId} />}
          {active === 'quiz' && <QuizPanel courseId={courseId} presetTopic={practiceTopic} />}
          {active === 'dashboard' && <Dashboard courseId={courseId} onStartQuiz={() => go('quiz')} />}
          {active === 'map' && <KnowledgeMap courseId={courseId} onPractice={topicId => { setPracticeTopic(topicId); go('quiz'); }} />}
          {active === 'revise' && <Revision courseId={courseId} onStartQuiz={() => { setPracticeTopic(undefined); go('quiz'); }} />}
          {active === 'exam-lab' && <ExamTools courseId={courseId} />}
        </div>
      </main>
    </ViewerProvider>
  </Frame>;
}
