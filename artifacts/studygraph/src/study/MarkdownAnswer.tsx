import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/** Render model text as Markdown and math. Raw HTML is intentionally not enabled. */
export function MarkdownAnswer({ children }: { children: string }) {
  return <div className="cx-answer text-sm leading-7 text-[#2d4439]">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {children}
    </ReactMarkdown>
  </div>;
}
