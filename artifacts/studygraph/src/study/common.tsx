import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, FileText, Film, Presentation, X } from 'lucide-react';
import { sourcePageImageUrl, useSourceView, useUnit } from './api';
import type { Citation, Locator } from './types';

export function locatorLabel(locator: Locator): string {
  if (locator.type === 'page') return `p. ${locator.page}`;
  if (locator.type === 'slide') return `slide ${locator.slide}`;
  const s = Math.floor(locator.start_sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function youtubeId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let id = host === 'youtu.be' ? u.pathname.split('/').filter(Boolean)[0] : u.searchParams.get('v');
    if (!id && ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

type ViewerTarget = { kind: 'unit'; unitId: string } | { kind: 'source'; sourceId: string; page?: number };
type ViewerApi = { open: (unitId: string) => void; openSource: (sourceId: string, page?: number) => void };
const ViewerContext = createContext<ViewerApi>({ open: () => undefined, openSource: () => undefined });
export const useViewer = () => useContext(ViewerContext);

export function ViewerProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const api = useMemo<ViewerApi>(() => ({
    open: unitId => setTarget({ kind: 'unit', unitId }),
    openSource: (sourceId, page) => setTarget({ kind: 'source', sourceId, page }),
  }), []);
  return <ViewerContext.Provider value={api}>
    {children}
    {target && <SourceViewer target={target} onClose={() => setTarget(null)} />}
  </ViewerContext.Provider>;
}

const navBtn = 'inline-flex items-center gap-1 rounded-full border border-[#d4d3c7] bg-[#f9f7ef] px-3 py-1.5 text-xs font-semibold text-[#365647] transition hover:bg-[#efede3] disabled:cursor-not-allowed disabled:opacity-40';

function clockLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

/**
 * Shows the real PDF page / slide image with previous and next controls. The server returns the stored
 * preview, or re-renders the page from the original PDF when no preview was stored. If both fail, a PDF
 * is shown through the browser's own viewer, and if that is not possible a clear note is shown.
 */
function DocumentPane({ sourceId, type, startPage, storedImageUrl, pageCount, fileUrl, title, highlightUnitId }: {
  sourceId: string; type: 'pdf' | 'pptx'; startPage: number; storedImageUrl: string | null; pageCount: number | null; fileUrl: string | null; title: string; highlightUnitId?: string;
}) {
  const [page, setPage] = useState(Math.max(1, startPage));
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const citedImage = type === 'pdf' && highlightUnitId && page === startPage
    ? sourcePageImageUrl(sourceId, page, highlightUnitId)
    : sourcePageImageUrl(sourceId, page);
  const sources = [citedImage, ...(page === startPage && storedImageUrl ? [storedImageUrl] : [])];
  const failed = attempt >= sources.length;
  const noun = type === 'pptx' ? 'Slide' : 'Page';
  const go = (next: number) => {
    const clamped = Math.max(1, pageCount ? Math.min(pageCount, next) : next);
    if (clamped === page) return;
    setPage(clamped); setAttempt(0); setLoaded(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(page + 1);
      if (e.key === 'ArrowLeft') go(page - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Warm the next page so paging feels instant.
  useEffect(() => {
    if (pageCount && page >= pageCount) return;
    const img = new Image();
    img.src = sourcePageImageUrl(sourceId, page + 1);
  }, [sourceId, page, pageCount]);

  return <div>
    <div className="mb-3 flex items-center justify-between gap-2">
      <button onClick={() => go(page - 1)} disabled={page <= 1} className={navBtn} aria-label={`Previous ${noun.toLowerCase()}`}><ChevronLeft size={14} /> Prev</button>
      <span className="font-mono-ui text-xs text-[#4d6358]" aria-live="polite">{noun} {page}{pageCount ? ` of ${pageCount}` : ''}</span>
      <button onClick={() => go(page + 1)} disabled={!!pageCount && page >= pageCount} className={navBtn} aria-label={`Next ${noun.toLowerCase()}`}>Next <ChevronRight size={14} /></button>
    </div>
    {!failed && <div className="relative">
      {!loaded && <div className="skeleton aspect-[3/4] w-full rounded-2xl" />}
      <img key={`${page}-${attempt}`} src={sources[attempt]} alt={`${title}, ${noun.toLowerCase()} ${page}`}
        onLoad={() => setLoaded(true)} onError={() => setAttempt(a => a + 1)}
        className={`w-full rounded-2xl border border-[#e1ddd2] bg-white ${loaded ? '' : 'absolute inset-0 opacity-0'}`} />
    </div>}
    {failed && type === 'pdf' && fileUrl && <div>
      <iframe key={page} title={`${title}, page ${page}`} src={`${fileUrl}#page=${page}`} className="h-[70dvh] w-full rounded-2xl border border-[#e1ddd2] bg-white" />
      <p className="mt-2 text-xs leading-5 text-[#7a6a45]">Showing the PDF in your browser's viewer. On phones this may not display; use "Open the original file" below.</p>
    </div>}
    {failed && !(type === 'pdf' && fileUrl) && <div className="rounded-xl border border-dashed border-[#d8cdb6] bg-[#fbf7ec] p-4 text-sm leading-6 text-[#7a6a45]">The {noun.toLowerCase()} preview is not available on this server. The text below was extracted from your source and is what the answer used. Upload the source again to restore the preview.</div>}
  </div>;
}

function SourceViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const unitQuery = useUnit(target.kind === 'unit' ? target.unitId : null);
  const sourceQuery = useSourceView(target.kind === 'unit' ? unitQuery.data?.source.id ?? null : target.sourceId);
  const viewer = useViewer();
  const query = target.kind === 'unit' ? unitQuery : sourceQuery;
  const unit = target.kind === 'unit' ? unitQuery.data : undefined;
  const view = target.kind === 'source' ? sourceQuery.data : undefined;
  const src = unit?.source ?? view;
  const chapters = sourceQuery.data?.chapters ?? [];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loc = unit?.locator;
  const start = loc?.type === 'video' ? Math.floor(loc.start_sec) : 0;
  const yt = youtubeId(src?.youtubeUrl ?? null);
  const startPage = loc?.type === 'page' ? loc.page : loc?.type === 'slide' ? loc.slide : target.kind === 'source' ? (target.page ?? 1) : 1;
  const pageCount = unit?.pageCount ?? view?.pageCount ?? null;
  const fileHref = src?.fileUrl
    ? (src.type === 'pdf' ? `${src.fileUrl}#page=${startPage}` : src.fileUrl)
    : null;
  const subtitle = unit && loc
    ? `${src?.type === 'video' ? 'Video at' : src?.type === 'pptx' ? 'Slide' : 'Page'} ${locatorLabel(loc).replace(/^(p\. |slide )/, '')}`
    : src ? (src.type === 'video' ? 'Video' : src.type === 'pptx' ? `Slide deck${pageCount ? ` · ${pageCount} slides` : ''}` : `PDF document${pageCount ? ` · ${pageCount} pages` : ''}`) : '';

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.readyState > 0 && Number.isFinite(start)) video.currentTime = start;
  }, [start]);

  return <div className="fixed inset-0 z-50 flex justify-end bg-[#20362e]/35" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <aside role="dialog" aria-label="Source viewer" className="flex h-[100dvh] w-full max-w-[680px] flex-col overflow-y-auto border-l border-[#dedbd0] bg-[#fbfaf5] shadow-2xl">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[#e4e1d6] bg-[#fbfaf5]/95 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <div className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-[#a67d4d]">Source</div>
          <h2 className="mt-1 truncate font-editorial text-2xl text-[#25473c]">{src?.title ?? 'Loading…'}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-[#718075]">{subtitle}</p>}
        </div>
        <button onClick={onClose} aria-label="Close source viewer" className="rounded-full p-2 text-[#718075] hover:bg-[#efede4]"><X size={18} /></button>
      </div>
      <div className="space-y-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {query.isLoading && <div className="skeleton h-64 rounded-2xl" />}
        {query.isError && <p role="alert" className="rounded-xl border border-[#e5c7c0] bg-[#faf0ed] p-4 text-sm text-[#854f45]">{(query.error as Error).message}</p>}
        {src && <>
          {src.type === 'video' && src.fileUrl && !videoFailed && (
            <video ref={videoRef} key={src.id} controls playsInline preload="metadata" src={src.fileUrl} className="w-full rounded-2xl bg-black"
              onError={() => setVideoFailed(true)}
              onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = start; }} />
          )}
          {src.type === 'video' && (!src.fileUrl || videoFailed) && yt && (
            <iframe title="Lecture video" className="aspect-video w-full rounded-2xl" src={`https://www.youtube.com/embed/${yt}?start=${start}`} allow="accelerometer; encrypted-media; picture-in-picture" allowFullScreen />
          )}
          {src.type === 'video' && videoFailed && !yt && <p className="rounded-xl border border-dashed border-[#d8cdb6] bg-[#fbf7ec] p-4 text-sm text-[#7a6a45]">The video file is not stored on this server. The text below is the transcript the answer used.</p>}
          {src.type === 'video' && chapters.length > 0 && <section className="rounded-2xl border border-[#e1ddd2] bg-white p-4">
            <div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Video chapters · click to seek</div>
            <div className="mt-3 max-h-52 space-y-1 overflow-y-auto">{chapters.map((chapter, index) => <button key={chapter.unitId} onClick={() => viewer.open(chapter.unitId)} aria-current={target.kind === 'unit' && target.unitId === chapter.unitId ? 'true' : undefined}
              className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-[#f5f3eb] ${target.kind === 'unit' && target.unitId === chapter.unitId ? 'bg-[#edf2e9] text-[#25473c]' : 'text-[#596e61]'}`}>
              <span className="mt-0.5 shrink-0 rounded-md bg-[#f2eee2] px-2 py-0.5 font-mono-ui text-[10px] text-[#8a6a1f]">{clockLabel(chapter.startSec)}</span>
              <span className="line-clamp-2 text-xs leading-5">{chapter.title || `Chapter ${index + 1}`}</span>
            </button>)}</div>
          </section>}
          {src.type !== 'video' && <DocumentPane key={src.id} sourceId={src.id} type={src.type} startPage={startPage} storedImageUrl={unit?.imageUrl ?? null} pageCount={pageCount} fileUrl={src.fileUrl} title={src.title} highlightUnitId={loc?.type === 'page' ? unit?.id : undefined} />}
          {loc?.type === 'page' && unit?.id && <p className="-mt-2 text-[11px] text-[#8a6a1f]">A soft amber mark highlights the cited passage when the PDF text can be matched.</p>}
          {unit?.figureCaption && <div className="rounded-xl border border-[#e1ddd2] bg-[#f4f1e6] p-4 text-sm leading-6 text-[#4d6358]"><div className="font-mono-ui mb-1 text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Figure content</div>{unit.figureCaption}</div>}
          {unit && <div className="rounded-xl border border-[#e1ddd2] bg-white p-4 text-sm leading-6 text-[#3d5348]"><div className="font-mono-ui mb-1 text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Cited text{loc && loc.type !== 'video' ? ` · ${loc.type === 'slide' ? 'slide' : 'page'} ${locatorLabel(loc).replace(/^(p\. |slide )/, '')}` : ''}</div><p className="whitespace-pre-wrap">{unit.text}</p></div>}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {fileHref && <a href={fileHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-[#25473c] hover:underline"><ExternalLink size={15} /> Open the original file{src.type === 'pdf' ? ` at page ${startPage}` : ''}</a>}
            {src.youtubeUrl && <a href={`${src.youtubeUrl}${src.youtubeUrl.includes('?') ? '&' : '?'}t=${start}s`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-[#25473c] hover:underline"><ExternalLink size={15} /> Open on YouTube{loc ? ` at ${locatorLabel(loc)}` : ''}</a>}
          </div>
        </>}
      </div>
    </aside>
  </div>;
}

const typeIcon = { pdf: FileText, pptx: Presentation, video: Film } as const;

/** Numbered citation chips; clicking opens the exact page, slide, or timestamp. */
export function CitationChips({ citations, compact = false }: { citations: Pick<Citation, 'unitId' | 'sourceTitle' | 'sourceType' | 'locator'>[]; compact?: boolean }) {
  const viewer = useViewer();
  if (citations.length === 0) return null;
  return <div className="flex flex-wrap gap-2">
    {citations.map((c, index) => {
      const Icon = typeIcon[c.sourceType] ?? BookOpen;
      return <button key={`${c.unitId}-${index}`} onClick={() => viewer.open(c.unitId)} title={`Open ${c.sourceTitle}, ${locatorLabel(c.locator)}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#d9d5c6] bg-[#f6f3e8] px-2.5 py-1 text-xs text-[#365647] transition hover:border-[#25473c] hover:bg-white">
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#25473c] text-[9px] font-semibold text-[#f6f0e3]">{index + 1}</span>
        <Icon size={12} className="shrink-0 text-[#a67d4d]" />
        <span className={`truncate ${compact ? 'max-w-[120px]' : 'max-w-[220px]'}`}>{c.sourceTitle}</span>
        <span className="font-mono-ui shrink-0 text-[10px] text-[#8a9286]">{locatorLabel(c.locator)}</span>
      </button>;
    })}
  </div>;
}

export const card = 'cx-card rounded-2xl border border-[#e1ddd2] bg-[#fbfaf5] p-5';
export const primaryBtn = 'inline-flex items-center justify-center gap-2 rounded-full bg-[#25473c] px-5 py-2.5 text-sm font-semibold text-[#f7f3e8] transition active:scale-95 hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,71,60,.22)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0';
export const ghostBtn = 'inline-flex items-center justify-center gap-2 rounded-full border border-[#d4d3c7] bg-[#f9f7ef] px-4 py-2 text-sm font-semibold text-[#365647] transition hover:bg-[#efede3] disabled:opacity-50';

export function statusColor(status: string, pKnown: number): string {
  if (status === 'untested') return '#e4e1d6';
  if (pKnown >= 0.8) return '#4f8a6a';
  if (pKnown >= 0.55) return '#c9b46a';
  return '#c9776a';
}

export function ErrorNote({ message }: { message: string }) {
  return <p role="alert" className="rounded-xl border border-[#e5c7c0] bg-[#faf0ed] px-4 py-3 text-sm text-[#854f45]">{message}</p>;
}

export function Spinner({ label }: { label: string }) {
  return <div className="flex items-center gap-3 text-sm text-[#718075]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[#cfd6cb] border-t-[#25473c]" />{label}</div>;
}
