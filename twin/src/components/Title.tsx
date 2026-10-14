import type { ReactNode } from "react";

interface TitleProps {
  children: ReactNode;
  subtitle: string;
  note?: string;
  trailing?: ReactNode;
}

export function Title({ children, subtitle, note, trailing }: TitleProps) {
  return (
    <div className="card-heading">
      <div>
        <h2 className="type-title">
          {children}
          {note && <span className="heading-note type-note">{note}</span>}
        </h2>
        <div className="subtitle type-subtitle">{subtitle}</div>
      </div>
      {trailing}
    </div>
  );
}
