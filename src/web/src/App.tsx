/**
 * Root React composition for the Coleo browser workbench.
 *
 * Global providers live here so every Golden Layout panel shares the same
 * theme, messages, query cache, and live projection transport.
 */
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { APP_ROUTES } from '@/app/routes';
import { AppMessageOverlay } from '@/components/AppMessageOverlay';
import { InterfaceTypography } from '@/components/InterfaceTypography';
import { ProjectOnboardingGate } from '@/components/ProjectOnboarding';
import { Layout } from '@/components';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { ToastProvider, MessageProvider, ThemeProvider } from '@/lib';
import { GoldenWorkspace } from '@/workspace/GoldenWorkspace';
import { LiveProjectionProvider } from '@/workbench/live-projections';
import { WorkbenchProfileProvider } from '@/workbench/profile-context';

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
          <LiveProjectionProvider>
            <WorkbenchProfileProvider>
              <BrowserRouter>
                <ProjectOnboardingGate>
                  <InterfaceTypography />
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
                </ProjectOnboardingGate>
              </BrowserRouter>
            </WorkbenchProfileProvider>
          </LiveProjectionProvider>
        </MessageProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
