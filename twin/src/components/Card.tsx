import type { PropsWithChildren } from "react";

interface CardProps extends PropsWithChildren {
  className?: string;
  label?: string;
}

export function Card({ children, className = "", label }: CardProps) {
  return (
    <section className={`card ${className}`} aria-label={label}>
      {children}
    </section>
  );
}
