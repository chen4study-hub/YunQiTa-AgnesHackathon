import type { ReactNode } from "react";

interface TableProps {
  headers: string[];
  rows: ReactNode[][];
  label: string;
}

export function Table({ headers, rows, label }: TableProps) {
  return (
    <div
      className="table-scroll"
      role="region"
      aria-label={`${label}，可横向滚动`}
      tabIndex={0}
    >
      <table aria-label={label}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, column) => (
                <td key={column}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
