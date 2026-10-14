import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { useGraph, xfetch } from './api';
import { card, CitationChips, ErrorNote, primaryBtn, statusColor } from './common';
import type { Citation } from './types';

const NODE_W = 176;
const NODE_H = 46;
const COL_GAP = 96;
const ROW_GAP = 14;

export function KnowledgeMap({ courseId, onPractice }: { courseId: string; onPractice: (topicId: string) => void }) {
  const { data, isLoading, isError, error } = useGraph(courseId);
  const [topicFilter, setTopicFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['x-concept', courseId, selected], enabled: !!selected,
    queryFn: () => xfetch<{ id: string; name: string; description: string | null; topicId: string; citations: Citation[] }>(`/x/courses/${courseId}/concepts/${selected}`),
  });

  const layout = useMemo(() => {
    if (!data) return null;
    const concepts = data.concepts.filter(c => !topicFilter || c.topicId === topicFilter);
    const ids = new Set(concepts.map(c => c.id));
    const edges = data.edges.filter(e => ids.has(e.from) && ids.has(e.to));
    const depth = new Map(concepts.map(c => [c.id, 0] as [string, number]));
    for (let pass = 0; pass < concepts.length; pass += 1) {
      let changed = false;
      for (const e of edges) {
        const next = Math.min(8, (depth.get(e.from) ?? 0) + 1);
        if (next > (depth.get(e.to) ?? 0)) { depth.set(e.to, next); changed = true; }
      }
      if (!changed) break;
    }
    const topicOrder = new Map(data.topics.map((t, i) => [t.id, i] as [string, number]));
    const useTopicColumns = edges.length === 0;
    const columns = new Map<number, typeof concepts>();
    for (const c of concepts) {
      const col = useTopicColumns ? (topicOrder.get(c.topicId) ?? 0) : (depth.get(c.id) ?? 0);
      columns.set(col, [...(columns.get(col) ?? []), c]);
    }
    const colKeys = [...columns.keys()].sort((a, b) => a - b);
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 0;
    colKeys.forEach((key, colIndex) => {
      const list = (columns.get(key) ?? []).sort((a, b) => (topicOrder.get(a.topicId) ?? 0) - (topicOrder.get(b.topicId) ?? 0) || a.name.localeCompare(b.name));
      maxRows = Math.max(maxRows, list.length);
      list.forEach((c, row) => pos.set(c.id, { x: 20 + colIndex * (NODE_W + COL_GAP), y: 20 + row * (NODE_H + ROW_GAP) }));
    });
    return { concepts, edges, pos, width: 40 + colKeys.length * (NODE_W + COL_GAP), height: 40 + maxRows * (NODE_H + ROW_GAP), topicColumns: useTopicColumns };
  }, [data, topicFilter]);

  if (isLoading) return <div className="skeleton h-96 rounded-2xl" />;
  if (isError || !data || !layout) return <ErrorNote message={(error as Error)?.message ?? 'Could not load the course map.'} />;
  if (data.concepts.length === 0) return <div className={`${card} text-center text-sm text-[#718075]`}>The course map appears after a source finishes processing.</div>;

  const current = data.concepts.find(c => c.id === selected);
  const linked = new Set(layout.edges.filter(e => e.from === selected || e.to === selected).flatMap(e => [e.from, e.to]));

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-xl text-sm leading-6 text-[#718075]">{layout.topicColumns ? 'Concepts grouped by topic (no prerequisite links were detected).' : 'Arrows run from a prerequisite to the concept that builds on it.'} Color shows your estimated mastery.</p>
      <label className="text-sm text-[#4d6358]"><span className="sr-only">Filter by topic</span>
        <select value={topicFilter} onChange={e => { setTopicFilter(e.target.value); setSelected(null); }} className="rounded-full border border-[#d4d3c7] bg-[#f9f7ef] px-3 py-2 text-sm">
          <option value="">All topics</option>{data.topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    </div>
    <div className="flex flex-wrap gap-3 text-xs text-[#718075]">{[['untested', 0], ['weak', 0.2], ['learning', 0.6], ['strong', 0.9]].map(([label, p]) => <span key={label as string} className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded" style={{ background: statusColor(label as string, p as number) }} />{label as string}</span>)}</div>

    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="max-h-[70dvh] overflow-auto rounded-2xl border border-[#e1ddd2] bg-[#fbfaf5]">
        <svg width={layout.width} height={layout.height} role="img" aria-label="Course concept map">
          <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#a9b3a8" /></marker></defs>
          {layout.edges.map(e => {
            const a = layout.pos.get(e.from); const b = layout.pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
            const dx = Math.max(30, (x2 - x1) / 2);
            const active = selected && (e.from === selected || e.to === selected);
            return <path key={`${e.from}-${e.to}`} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} fill="none" stroke={active ? '#25473c' : '#cfd6cb'} strokeWidth={active ? 2 : 1.2} markerEnd="url(#arrow)" opacity={selected && !active ? 0.35 : 1} />;
          })}
          {layout.concepts.map(c => {
            const p = layout.pos.get(c.id); if (!p) return null;
            const dim = selected && c.id !== selected && !linked.has(c.id);
            return <g key={c.id} transform={`translate(${p.x},${p.y})`} tabIndex={0} role="button" aria-label={`${c.name}, ${c.status}`} style={{ cursor: 'pointer', opacity: dim ? 0.4 : 1 }}
              onClick={() => setSelected(c.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(c.id); } }}>
              <rect width={NODE_W} height={NODE_H} rx={12} fill="#fff" stroke={selected === c.id ? '#25473c' : '#d9d5c6'} strokeWidth={selected === c.id ? 2.5 : 1} />
              <rect width={8} height={NODE_H} rx={4} fill={statusColor(c.status, c.pKnown)} />
              <text x={18} y={NODE_H / 2 + 4} fontSize={12} fill="#25473c">{c.name.length > 24 ? `${c.name.slice(0, 23)}…` : c.name}</text>
              <title>{c.name}</title>
            </g>;
          })}
        </svg>
      </div>
      <aside className={`${card} h-fit`}>
        {!current ? <p className="text-sm text-[#718075]">Select a concept to see what it covers, how well you know it, and where it appears in your sources.</p> : <div className="space-y-3">
          <div><div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">{data.topics.find(t => t.id === current.topicId)?.name}</div>
            <h3 className="font-editorial text-2xl text-[#25473c]">{current.name}</h3></div>
          {current.description && <p className="text-sm leading-6 text-[#4d6358]">{current.description}</p>}
          <p className="text-sm text-[#718075]">Mastery: <b className="text-[#25473c]">{current.attempts ? `${Math.round(current.pKnown * 100)}% (${current.status})` : 'not tested yet'}</b></p>
          {detail.isLoading ? <div className="skeleton h-12 rounded-xl" /> : detail.data && <div><div className="font-mono-ui mb-1.5 text-[10px] uppercase tracking-[.14em] text-[#a67d4d]">Appears in</div><CitationChips citations={detail.data.citations} compact /></div>}
          <button onClick={() => onPractice(current.topicId)} className={primaryBtn}><Target size={15} /> Practice this topic</button>
        </div>}
      </aside>
    </div>
  </div>;
}
