interface ValueCellProps {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  size?: 'large' | 'medium';
}

export function ValueCell({ label, value, unit, note, size = 'medium' }: ValueCellProps) {
  return (
    <div className="value-cell metric-value">
      <span className="type-subtitle">{label}</span>
      <strong className={`type-number type-number-${size === 'large' ? 'lg' : 'md'}`}>
        {value}
        {unit && <small className="unit type-unit">{'\u00a0'}{unit}</small>}
      </strong>
      {note && <small className="value-note type-note">{note}</small>}
    </div>
  );
}
