import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components';
import { ToastProvider } from '@/lib';
import {
  DashboardPage,
  ArmsPage,
  ArmViewerPage,
  BrainPage,
  GardenPage,
  ActivityPage,
  SettingsPage,
  TasksPage,
  MessagingPage,
} from '@/pages';

function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="arms" element={<ArmsPage />} />
            <Route path="viewer" element={<ArmViewerPage />} />
            <Route path="brain" element={<BrainPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="garden" element={<GardenPage />} />
              <Route path="messaging" element={<MessagingPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

export default App;
