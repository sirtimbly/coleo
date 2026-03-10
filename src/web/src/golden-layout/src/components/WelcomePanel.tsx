import './WelcomePanel.css';

interface WelcomePanelProps {
  onAddSpreadsheet: () => void;
  onAddHtml: () => void;
}

export function WelcomePanel({ onAddSpreadsheet, onAddHtml }: WelcomePanelProps) {
  return (
    <div className="welcome-panel">
      <div className="welcome-header">
        <h1>📊 Dockable Workbench</h1>
        <p>Drag, drop, and organize your workspace</p>
      </div>
      
      <div className="welcome-section">
        <h3>Quick Actions</h3>
        <div className="action-grid">
          <button className="action-card" onClick={onAddSpreadsheet}>
            <span className="action-icon">📈</span>
            <span className="action-label">New Spreadsheet</span>
          </button>
          <button className="action-card" onClick={onAddHtml}>
            <span className="action-icon">📝</span>
            <span className="action-label">New Document</span>
          </button>
        </div>
      </div>

      <div className="welcome-section">
        <h3>Features</h3>
        <ul className="feature-list">
          <li>
            <span className="feature-icon">🪟</span>
            <div>
              <strong>Split Panes</strong>
              <p>Drag dividers to resize panels</p>
            </div>
          </li>
          <li>
            <span className="feature-icon">📑</span>
            <div>
              <strong>Tabbed Interface</strong>
              <p>Stack multiple sheets in one pane</p>
            </div>
          </li>
          <li>
            <span className="feature-icon">🖱️</span>
            <div>
              <strong>Drag & Drop</strong>
              <p>Move tabs between panes</p>
            </div>
          </li>
          <li>
            <span className="feature-icon">💾</span>
            <div>
              <strong>Save Layout</strong>
              <p>Preserve your workspace configuration</p>
            </div>
          </li>
        </ul>
      </div>

      <div className="welcome-section">
        <h3>How to Use</h3>
        <ol className="usage-list">
          <li>Click and drag tabs to move them between panes</li>
          <li>Drag panel borders to resize</li>
          <li>Right-click on tabs for more options</li>
          <li>Use the toolbar to add new panels</li>
          <li>Save your layout to restore later</li>
        </ol>
      </div>

      <div className="welcome-footer">
        <p>Built with Golden Layout + React Spreadsheet</p>
      </div>
    </div>
  );
}
