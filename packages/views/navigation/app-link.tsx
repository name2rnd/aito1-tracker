"use client";

import { forwardRef } from "react";
import { useNavigation } from "./context";

interface AppLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  /**
   * When set, a plain (unmodified) click runs this instead of navigating to
   * `href` — used to open an issue in the peek sidebar. Modifier clicks
   * (cmd/ctrl/shift) still open `href` in a new tab / full page, and the `href`
   * stays on the anchor for middle-click and accessibility.
   */
  onActivate?: () => void;
}

export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(
  function AppLink({ href, children, onClick, onActivate, ...props }, ref) {
    const { push, openInNewTab } = useNavigation();

    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        if (openInNewTab) {
          e.preventDefault();
          openInNewTab(href);
        }
        return;
      }
      e.preventDefault();
      onClick?.(e);
      if (onActivate) {
        onActivate();
        return;
      }
      push(href);
    };

    return (
      <a ref={ref} href={href} onClick={handleClick} {...props}>
        {children}
      </a>
    );
  },
);
