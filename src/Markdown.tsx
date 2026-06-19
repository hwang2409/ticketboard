import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      rel="noreferrer noopener"
      target={href?.startsWith('#') ? undefined : '_blank'}
    >
      {children}
    </a>
  ),
};

function MarkdownInner({ text, className }: { text: string; className?: string }) {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {trimmed}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownInner);

/**
 * Lossy plain-text rendering of markdown for dense list-row previews where a
 * full ReactMarkdown subtree would break click targets or layout. Strips the
 * most common syntax tokens; leaves link text behind.
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  return (
    text
      // Fenced code blocks → keep inner text
      .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
      // Inline code
      .replace(/`([^`]+)`/g, '$1')
      // Images ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Links [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Reference links [text][ref] → text
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      // Bold/italic markers (handle ** before *)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|\W)_([^_]+)_(\W|$)/g, '$1$2$3')
      // Strikethrough ~~x~~
      .replace(/~~([^~]+)~~/g, '$1')
      // Headings #, ##, etc. at line start
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      // Blockquote >
      .replace(/^\s{0,3}>\s?/gm, '')
      // List markers - * + 1.
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
      // Horizontal rules
      .replace(/^\s{0,3}([-*_])\s*\1\s*\1[-*_\s]*$/gm, '')
      // Collapse runs of whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
