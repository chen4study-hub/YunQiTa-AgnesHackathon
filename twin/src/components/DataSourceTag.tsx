interface DataSourceTagProps {
  name: string;
}

export function DataSourceTag({ name }: DataSourceTagProps) {
  return (
    <div className="source-tag">
      <span className="type-subtitle">
        <i aria-hidden="true" />
        {name}
      </span>
      <small className="type-note">LIVE · 已接入</small>
    </div>
  );
}
