import { useState } from 'react';
import './HtmlPanel.css';

interface HtmlPanelProps {
  title: string;
  content?: string;
}

export function HtmlPanel({ title, content = '<p>Edit this content...</p>' }: HtmlPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [htmlContent, setHtmlContent] = useState(content);

  return (
    <div className="html-panel">
      <div className="html-panel-toolbar">
        <span className="html-panel-title">{title}</span>
        <div className="html-panel-actions">
          <button 
            className={`action-btn ${isEditing ? 'active' : ''}`}
            onClick={() => setIsEditing(!isEditing)}
          >
            {isEditing ? '👁️ View' : '✏️ Edit'}
          </button>
        </div>
      </div>
      <div className="html-panel-content">
        {isEditing ? (
          <textarea
            className="html-editor"
            value={htmlContent}
            onChange={(e) => setHtmlContent(e.target.value)}
            placeholder="Enter HTML content..."
          />
        ) : (
          <div 
            className="html-preview"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        )}
      </div>
    </div>
  );
}
