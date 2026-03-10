import { useState } from 'react';
import Spreadsheet from 'react-spreadsheet';
import type { CellBase, Matrix } from 'react-spreadsheet';
import './SpreadsheetPanel.css';

interface SpreadsheetPanelProps {
  title: string;
  data?: any;
}

// Define cell type
interface CellData extends CellBase {
  value: string | number;
}

export function SpreadsheetPanel({ title }: SpreadsheetPanelProps) {
  // Initialize with sample data
  const [data, setData] = useState<Matrix<CellData>>([
    [{ value: 'Hello' }, { value: 'World' }],
    [{ value: '100' }, { value: '200' }, { value: '=A2+B2' }],
    [{ value: '' }, { value: '' }],
    [{ value: 'React Spreadsheet' }, { value: '' }],
    [{ value: 'Try editing cells!' }, { value: '' }],
  ]);

  const handleChange = (newData: Matrix<CellData>) => {
    setData(newData);
  };

  return (
    <div className="spreadsheet-panel">
      <div className="spreadsheet-title-bar">
        <span className="spreadsheet-title">{title}</span>
        <div className="spreadsheet-actions">
          <button className="action-btn" title="Add Row">➕</button>
          <button className="action-btn" title="Export">📤</button>
        </div>
      </div>
      <div className="spreadsheet-container">
        <Spreadsheet 
          data={data} 
          onChange={handleChange}
          className="react-spreadsheet"
        />
      </div>
    </div>
  );
}
