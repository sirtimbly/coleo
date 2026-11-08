import { useWorkspaceOpenRoute } from "@/workspace/route-context";
import type { ReactElement } from "react";

/** Render our limited, generated message format without executing arbitrary HTML
 * or depending on the global Adaptive Cards markdown hook being installed.
 */
export function CatchupMessageBody({ body }: { body: string }): ReactElement {
  const openRoute = useWorkspaceOpenRoute();
  return <div className="max-w-prose space-y-3 text-sm leading-relaxed">
    {body.split(/\n\s*\n/).map((block, index) => {
      if (block.startsWith("## ")) return <h3 key={index} className="pt-3 text-base font-semibold">{block.slice(3)}</h3>;
      const link = block.match(/^- \[([^\]]*)\]\((\/messaging\?[^)]*)\)(.*)$/s);
      if (link) {
        const href = link[2]!;
        return <p key={index} className="break-words">
          <a href={href} className="text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
            onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              openRoute({ pathname: "/messaging", search: href.slice("/messaging".length), title: link[1] }, "split");
            }}>{link[1]}</a><span className="text-muted-foreground">{link[3]}</span>
        </p>;
      }
      if (block.startsWith("_") && block.endsWith("_")) return <p key={index} className="text-xs text-muted-foreground">{block.slice(1, -1)}</p>;
      return <p key={index} className="whitespace-pre-wrap break-words">{block}</p>;
    })}
  </div>;
}
