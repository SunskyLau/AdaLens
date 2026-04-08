import { Routes, Route } from 'react-router-dom';
import Workspace from './pages/Workspace';

function App() {
  return (
    <div className="min-h-screen bg-slate-50">
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="/c/:runId" element={<Workspace />} />
      </Routes>
    </div>
  );
}

export default App;
