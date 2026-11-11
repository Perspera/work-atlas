import type { ReactNode } from "react";

import { useApp } from "../lib/store";

export function Loading({ text = "加载中" }: { text?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {text}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function Panel({
  title,
  sub,
  actions,
  flush,
  children,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <div className="panel-title">{title}</div>}
            {sub && <div className="panel-sub">{sub}</div>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      <div className={flush ? "panel-body flush" : "panel-body"}>{children}</div>
    </section>
  );
}

export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {children && <div className="toolbar">{children}</div>}
    </div>
  );
}

export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge${kind ? ` ${kind}` : ""}`}>{children}</span>;
}

export function Modal({
  title,
  onClose,
  footer,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className={`modal${wide ? " wide" : ""}`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toaster() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismiss);
  if (!toasts.length) return null;
  return (
    <div id="toasts">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`} onClick={() => dismiss(item.id)}>
          {item.text}
        </div>
      ))}
    </div>
  );
}
