import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import Overview from './pages/Overview';
import Targets from './pages/Targets';
import Launcher from './pages/Launcher';
import RunDetail from './pages/RunDetail';
import Findings from './pages/Findings';
import Reports, { Compare } from './pages/Reports';
import Stress from './pages/Stress';
import Journeys from './pages/Journeys';

const NAV = [
  ['/', 'Overview'], ['/targets', 'Targets'], ['/load', 'Load tests'], ['/stress', 'Stress'], ['/journeys', 'Journeys'], ['/crawl', 'Crawler'],
  ['/security', 'Security'], ['/findings', 'Findings'], ['/reports', 'Reports'],
] as const;

function Health() {
  const [h, setH] = useState<{ ok: boolean; database: boolean; redis: boolean } | null>(null);
  useEffect(() => {
    const tick = () => api('/health').then(setH, () => setH({ ok: false, database: false, redis: false }));
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
  const dot = (ok?: boolean) => <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-500'}`} />;
  return (
    <div className="space-y-1 px-4 py-3 text-xs text-muted">
      <div className="flex items-center gap-2">{dot(h?.ok !== undefined)} API {h ? (h.ok ? 'online' : 'degraded') : '…'}</div>
      <div className="flex items-center gap-2">{dot(h?.database)} PostgreSQL</div>
      <div className="flex items-center gap-2">{dot(h?.redis)} Redis</div>
    </div>
  );
}

export default function App() {
  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 py-4 text-base font-semibold">SiteGuard <span className="text-accent">Local</span></div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}
              className={({ isActive }) => `block rounded-md px-3 py-2 ${isActive ? 'bg-white/10 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <Health />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/targets" element={<Targets />} />
            <Route path="/load" element={<Launcher type="LOAD" />} />
            <Route path="/stress" element={<Stress />} />
            <Route path="/journeys" element={<Journeys />} />
            <Route path="/crawl" element={<Launcher type="CRAWL" />} />
            <Route path="/security" element={<Launcher type="SECURITY" />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/findings" element={<Findings />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/reports/compare" element={<Compare />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
