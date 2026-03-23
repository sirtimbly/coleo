import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { APP_ROUTES } from '@/app/routes';
import { AppMessageOverlay } from '@/components/AppMessageOverlay';
import { Layout } from '@/components';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { ToastProvider, MessageProvider, ThemeProvider } from '@/lib';
import { GoldenWorkspace } from '@/workspace/GoldenWorkspace';

function AppShell() {
  const { layoutMode } = useLayoutMode();

  if (layoutMode === 'golden') {
    return <GoldenWorkspace />;
  }

  return (
    <Layout layoutMode={layoutMode}>
      <Outlet />
    </Layout>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <MessageProvider>
          <BrowserRouter>
            <AppMessageOverlay />
            <Routes>
              <Route path="/" element={<AppShell />}>
                {APP_ROUTES.map((route) => {
                  const RouteComponent = route.component;

                  if (route.index) {
                    return <Route key={route.id} index element={<RouteComponent />} />;
                  }

                  return (
                    <Route
                      key={route.id}
                      path={route.path}
                      element={<RouteComponent />}
                    />
                  );
                })}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </MessageProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
