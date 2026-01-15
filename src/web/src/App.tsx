import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components';
import {
  DashboardPage,
  ArmsPage,
  ArmViewerPage,
  BrainPage,
  GardenPage,
  MailPage,
  ProposalsPage,
  ActivityPage,
  SettingsPage,
  TasksPage,
} from '@/pages';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="arms" element={<ArmsPage />} />
          <Route path="viewer" element={<ArmViewerPage />} />
          <Route path="brain" element={<BrainPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="garden" element={<GardenPage />} />
          <Route path="mail" element={<MailPage />} />
          <Route path="proposals" element={<ProposalsPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
