import { useEffect, useRef, useCallback } from 'react';
import { GoldenLayout, LayoutConfig } from 'golden-layout';
import { createRoot } from 'react-dom/client';
import { SpreadsheetPanel } from './components/SpreadsheetPanel';
import { HtmlPanel } from './components/HtmlPanel';
import { WelcomePanel } from './components/WelcomePanel';
import { PanelHeader } from './components/PanelHeader';
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './App.css';

// Component types
export type PanelType = 'spreadsheet' | 'html' | 'welcome';

export interface PanelConfig {
  type: PanelType;
  title: string;
  data?: any;
}

function App() {
  const layoutContainerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<GoldenLayout | null>(null);

  // Function to add new panel
  const addNewPanel = useCallback((type: PanelType) => {
    if (!layoutRef.current) return;

    const layout = layoutRef.current;
    
    // Count existing panels for naming
    let sheetCount = 0;
    let docCount = 0;
    
    const countItems = (item: any) => {
      if (item.componentType === 'spreadsheet') sheetCount++;
      if (item.componentType === 'html') docCount++;
      if (item.contentItems) {
        item.contentItems.forEach(countItems);
      }
    };
    
    if (layout.rootItem) {
      countItems(layout.rootItem);
    }

    const newTitle = type === 'spreadsheet' 
      ? `Sheet ${sheetCount + 1}`
      : `Document ${docCount + 1}`;

    // Add to first stack or create new
    layout.addComponent(type, { type, title: newTitle, data: type === 'html' ? { content: '<p>New document content...</p>' } : undefined }, newTitle);
  }, []);

  // Register components with Golden Layout
  useEffect(() => {
    if (!layoutContainerRef.current || layoutRef.current) return;

    const layout = new GoldenLayout(layoutContainerRef.current);
    layoutRef.current = layout;

    // Register component types
    layout.registerComponentFactoryFunction('spreadsheet', (container, state) => {
      const rootElement = document.createElement('div');
      rootElement.style.width = '100%';
      rootElement.style.height = '100%';
      rootElement.style.overflow = 'hidden';
      container.element.appendChild(rootElement);

      const config = state as PanelConfig;
      const reactRoot = createRoot(rootElement);
      reactRoot.render(<SpreadsheetPanel title={config.title} data={config.data} />);

      container.on('destroy', () => {
        reactRoot.unmount();
      });
    });

    layout.registerComponentFactoryFunction('html', (container, state) => {
      const rootElement = document.createElement('div');
      rootElement.style.width = '100%';
      rootElement.style.height = '100%';
      container.element.appendChild(rootElement);

      const config = state as PanelConfig;
      const reactRoot = createRoot(rootElement);
      reactRoot.render(<HtmlPanel title={config.title} content={config.data?.content} />);

      container.on('destroy', () => {
        reactRoot.unmount();
      });
    });

    layout.registerComponentFactoryFunction('welcome', (container) => {
      const rootElement = document.createElement('div');
      rootElement.style.width = '100%';
      rootElement.style.height = '100%';
      container.element.appendChild(rootElement);

      const reactRoot = createRoot(rootElement);
      reactRoot.render(
        <WelcomePanel 
          onAddSpreadsheet={() => addNewPanel('spreadsheet')} 
          onAddHtml={() => addNewPanel('html')} 
        />
      );

      container.on('destroy', () => {
        reactRoot.unmount();
      });
    });

    // Initial layout configuration
    const initialLayout: LayoutConfig = {
      root: {
        type: 'row',
        content: [
          {
            type: 'column',
            width: 30,
            content: [
              {
                type: 'component',
                componentType: 'welcome',
                title: 'Welcome',
                isClosable: false
              }
            ]
          },
          {
            type: 'column',
            width: 70,
            content: [
              {
                type: 'stack',
                content: [
                  {
                    type: 'component',
                    componentType: 'spreadsheet',
                    title: 'Sheet 1',
                    componentState: { type: 'spreadsheet', title: 'Sheet 1' } as PanelConfig
                  },
                  {
                    type: 'component',
                    componentType: 'spreadsheet',
                    title: 'Sheet 2',
                    componentState: { type: 'spreadsheet', title: 'Sheet 2' } as PanelConfig
                  }
                ]
              },
              {
                type: 'stack',
                height: 40,
                content: [
                  {
                    type: 'component',
                    componentType: 'html',
                    title: 'Notes',
                    componentState: { type: 'html', title: 'Notes', data: { content: '<h3>Project Notes</h3><p>Add your notes here...</p>' } } as PanelConfig
                  }
                ]
              }
            ]
          }
        ]
      }
    };

    layout.loadLayout(initialLayout);

    // Handle window resize
    const handleResize = () => {
      layout.setSize(window.innerWidth, window.innerHeight - 50);
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      layout.destroy();
      layoutRef.current = null;
    };
  }, [addNewPanel]);

  // Save layout
  const saveLayout = useCallback(() => {
    if (!layoutRef.current) return;
    const savedLayout = layoutRef.current.saveLayout();
    localStorage.setItem('savedLayout', JSON.stringify(savedLayout));
    alert('Layout saved!');
  }, []);

  // Load layout
  const loadLayout = useCallback(() => {
    if (!layoutRef.current) return;
    const saved = localStorage.getItem('savedLayout');
    if (saved) {
      try {
        const config = JSON.parse(saved);
        layoutRef.current.loadLayout(config);
        alert('Layout loaded!');
      } catch (e) {
        alert('Error loading layout');
      }
    } else {
      alert('No saved layout found');
    }
  }, []);

  return (
    <div className="app">
      <PanelHeader 
        onAddSpreadsheet={() => addNewPanel('spreadsheet')}
        onAddHtml={() => addNewPanel('html')}
        onSaveLayout={saveLayout}
        onLoadLayout={loadLayout}
      />
      <div 
        ref={layoutContainerRef} 
        className="layout-container"
        style={{ width: '100%', height: 'calc(100vh - 50px)' }}
      />
    </div>
  );
}

export default App;
