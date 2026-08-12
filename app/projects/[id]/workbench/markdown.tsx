import { Fragment } from "react";
import { parseMarkdownBlock, type InlineNode } from "./markdown-parse";

/** Per-level heading style, stepping down from the `text-xl` prose baseline. */
const HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "text-xl",
  2: "text-lg",
  3: "text-base",
  4: "text-[15px]",
  5: "text-sm",
  6: "text-xs",
};

const CODE_CLASS = "rounded bg-slate-100 px-1 font-mono text-[13px]";
const LINK_CLASS =
  "text-blue-700 underline decoration-blue-300 hover:decoration-blue-600";
const PROSE_CLASS = "text-[15px] leading-relaxed text-slate-800";

function InlineNodes({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.t) {
          case "strong":
            return <strong key={index}>{node.v}</strong>;
          case "em":
            return <em key={index}>{node.v}</em>;
          case "code":
            return (
              <code key={index} className={CODE_CLASS}>
                {node.v}
              </code>
            );
          case "link":
            return (
              <a
                key={index}
                href={node.href}
                className={LINK_CLASS}
                target="_blank"
                rel="noreferrer noopener"
              >
                {node.v}
              </a>
            );
          case "text":
            return <Fragment key={index}>{node.v}</Fragment>;
        }
      })}
    </>
  );
}

/** Renders one Markdown block (see `parseMarkdownBlock`) as its matching
 * element, with Tailwind classes consistent with the app's existing prose. */
export function MarkdownBlock({ text }: { text: string }) {
  const node = parseMarkdownBlock(text);

  switch (node.t) {
    case "heading": {
      const Tag = `h${node.level}` as const;
      return (
        <Tag
          className={`font-semibold text-slate-900 ${HEADING_CLASS[node.level]}`}
        >
          <InlineNodes nodes={node.inline} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className={PROSE_CLASS}>
          <InlineNodes nodes={node.inline} />
        </p>
      );
    case "list": {
      const ListTag = node.ordered ? "ol" : "ul";
      return (
        <ListTag
          className={`${PROSE_CLASS} ${node.ordered ? "list-decimal" : "list-disc"} pl-5`}
        >
          {node.items.map((item, index) => (
            <li key={index}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "blockquote":
      return (
        <blockquote
          className={`${PROSE_CLASS} border-l-2 border-slate-300 pl-3 text-slate-600`}
        >
          <InlineNodes nodes={node.inline} />
        </blockquote>
      );
    case "codeblock":
      return (
        <pre className="overflow-x-auto rounded bg-slate-100 p-3 font-mono text-[13px] text-slate-800">
          <code>{node.v}</code>
        </pre>
      );
  }
}
