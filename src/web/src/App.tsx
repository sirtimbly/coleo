import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components';
import {
  DashboardPage,
  ArmsPage,
  BrainPage,
  GardenPage,
  MailPage,
  ProposalsPage,
  ActivityPage,
  SettingsPage,
} from '@/pages';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="arms" element={<ArmsPage />} />
          <Route path="brain" element={<BrainPage />} />
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
