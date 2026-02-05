import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components';
import { ToastProvider, MessageProvider } from '@/lib';
import {
  DashboardPage,
  ArmsPage,
  ArmViewerPage,
  BrainPage,
  GardenPage,
  ActivityPage,
  SettingsPage,
  TasksPage,
  BugsPage,
  MessagingPage,
  UnifiedGridPage,
  MailPage,
} from '@/pages';

function App() {
  return (
    <ToastProvider>
      <MessageProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="arms" element={<ArmsPage />} />
              <Route path="viewer" element={<ArmViewerPage />} />
              <Route path="brain" element={<BrainPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="bugs" element={<BugsPage />} />
              <Route path="garden" element={<GardenPage />} />
              <Route path="messaging" element={<MessagingPage />} />
              <Route path="mail" element={<MailPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="grid" element={<UnifiedGridPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </MessageProvider>
    </ToastProvider>
  );
}

export default App;
