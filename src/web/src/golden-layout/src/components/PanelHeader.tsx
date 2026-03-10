import './PanelHeader.css';

interface PanelHeaderProps {
  onAddSpreadsheet: () => void;
  onAddHtml: () => void;
  onSaveLayout: () => void;
  onLoadLayout: () => void;
}

export function PanelHeader({ 
  onAddSpreadsheet, 
  onAddHtml, 
  onSaveLayout, 
  onLoadLayout 
}: PanelHeaderProps) {
  return (
    <div className="panel-header">
      <div className="header-left">
        <span className="logo">📊 Workbench</span>
      </div>
      
      <div className="header-center">
        <button className="header-btn" onClick={onAddSpreadsheet} title="Add Spreadsheet">
          <span className="btn-icon">📈</span>
          <span className="btn-label">Spreadsheet</span>
        </button>
        <button className="header-btn" onClick={onAddHtml} title="Add Document">
          <span className="btn-icon">📝</span>
          <span className="btn-label">Document</span>
        </button>
        <div className="divider" />
        <button className="header-btn" onClick={onSaveLayout} title="Save Layout">
          <span className="btn-icon">💾</span>
          <span className="btn-label">Save</span>
        </button>
        <button className="header-btn" onClick={onLoadLayout} title="Load Layout">
          <span className="btn-icon">📂</span>
          <span className="btn-label">Load</span>
        </button>
      </div>
      
      <div className="header-right">
        <span className="hint">Drag tabs to rearrange</span>
      </div>
    </div>
  );
}
